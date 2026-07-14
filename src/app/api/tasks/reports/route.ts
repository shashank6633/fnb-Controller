import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canManageTasks } from '@/lib/tasks';

/**
 * Task-Management analytics — /api/tasks/reports
 *
 * Read-only aggregate endpoint for the Reports page. One GET returns every
 * report section in a single payload, parameterized by ?from=YYYY-MM-DD&to=YYYY-MM-DD
 * and ?period=daily|weekly|monthly. The page's report-type selector just picks
 * which slice of this payload to render, so switching views never re-fetches.
 *
 * Sections:
 *   - summary                : totals + completion rate + current overdue count
 *   - status/priority/category breakdowns
 *   - period_series          : task counts bucketed by created_at period
 *   - department_performance : per-department throughput + avg completion mins
 *   - employee_productivity  : per-assignee throughput + on-time rate
 *   - hygiene_series/by_area : hygiene audit scores over time + per area
 *   - maintenance            : preventive-maintenance compliance %
 *   - training               : training-session completion
 *   - knowledge              : knowledge-test attempts + pass rate
 *   - overdue                : current overdue task list (state-based, not range)
 *
 * Access: management only (admin | manager | head chef | store manager) — these
 * are cross-employee performance figures. Enforced server-side; the page shows a
 * lock card for everyone else.
 */
export const dynamic = 'force-dynamic';

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canManageTasks(me)) {
      return Response.json({ error: 'Manager permission required' }, { status: 403 });
    }

    const db = getDb();
    const url = new URL(request.url);
    const today = todayISO();

    // Default window: trailing 30 days.
    const to = (url.searchParams.get('to') || today).slice(0, 10);
    const defFrom = (() => {
      const d = new Date(to + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 29);
      return d.toISOString().slice(0, 10);
    })();
    const from = (url.searchParams.get('from') || defFrom).slice(0, 10);
    const periodRaw = (url.searchParams.get('period') || 'daily').toLowerCase();
    const period: 'daily' | 'weekly' | 'monthly' =
      periodRaw === 'monthly' ? 'monthly' : periodRaw === 'weekly' ? 'weekly' : 'daily';

    const periodExpr =
      period === 'monthly'
        ? "strftime('%Y-%m', created_at)"
        : period === 'weekly'
        ? "strftime('%Y-W%W', created_at)"
        : 'date(created_at)';

    // Common range predicate on tasks.created_at (calendar-day compare).
    const rangeTasks = `is_archived = 0 AND date(created_at) BETWEEN ? AND ?`;
    const DONE = "status IN ('completed','approved')";

    /* ── summary ─────────────────────────────────────────────────────── */
    const summaryRow = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN ${DONE} THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
           SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
           SUM(CASE WHEN status IN ('draft','assigned','accepted') THEN 1 ELSE 0 END) AS open
         FROM tasks WHERE ${rangeTasks}`,
      )
      .get(from, to) as any;

    const overdueCountRow = db
      .prepare(
        `SELECT COUNT(*) AS c FROM tasks
          WHERE is_archived = 0 AND due_date != '' AND due_date < ?
            AND status NOT IN ('completed','approved','cancelled')`,
      )
      .get(today) as any;

    const total = Number(summaryRow?.total || 0);
    const completed = Number(summaryRow?.completed || 0);
    const summary = {
      total,
      completed,
      approved: Number(summaryRow?.approved || 0),
      in_progress: Number(summaryRow?.in_progress || 0),
      open: Number(summaryRow?.open || 0),
      overdue: Number(overdueCountRow?.c || 0),
      completion_rate: total > 0 ? Math.round((completed / total) * 1000) / 10 : 0,
    };

    /* ── breakdowns ──────────────────────────────────────────────────── */
    const status_breakdown = db
      .prepare(
        `SELECT status, COUNT(*) AS count FROM tasks WHERE ${rangeTasks}
          GROUP BY status ORDER BY count DESC`,
      )
      .all(from, to) as any[];

    const priority_breakdown = db
      .prepare(
        `SELECT priority, COUNT(*) AS count FROM tasks WHERE ${rangeTasks}
          GROUP BY priority ORDER BY count DESC`,
      )
      .all(from, to) as any[];

    const category_breakdown = db
      .prepare(
        `SELECT category, COUNT(*) AS count FROM tasks WHERE ${rangeTasks}
          GROUP BY category ORDER BY count DESC`,
      )
      .all(from, to) as any[];

    /* ── period series (created / completed / approved by created period) ─ */
    const period_series = db
      .prepare(
        `SELECT ${periodExpr} AS period,
                COUNT(*) AS created,
                SUM(CASE WHEN ${DONE} THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved
           FROM tasks WHERE ${rangeTasks}
          GROUP BY period ORDER BY period ASC`,
      )
      .all(from, to) as any[];

    /* ── department performance ──────────────────────────────────────── */
    const department_performance = (
      db
        .prepare(
          `SELECT
             CASE WHEN department = '' THEN '(Unassigned)' ELSE department END AS department,
             COUNT(*) AS total,
             SUM(CASE WHEN ${DONE} THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
             SUM(CASE WHEN due_date != '' AND due_date < ?
                       AND status NOT IN ('completed','approved','cancelled')
                      THEN 1 ELSE 0 END) AS overdue,
             AVG(CASE WHEN ${DONE} AND started_at IS NOT NULL AND completed_at IS NOT NULL
                      THEN (julianday(completed_at) - julianday(started_at)) * 1440 END) AS avg_minutes
           FROM tasks WHERE ${rangeTasks}
          GROUP BY department ORDER BY total DESC`,
        )
        .all(today, from, to) as any[]
    ).map((r) => ({
      department: r.department,
      total: Number(r.total || 0),
      completed: Number(r.completed || 0),
      approved: Number(r.approved || 0),
      overdue: Number(r.overdue || 0),
      avg_minutes: r.avg_minutes != null ? Math.round(Number(r.avg_minutes)) : null,
      completion_rate: r.total > 0 ? Math.round((r.completed / r.total) * 1000) / 10 : 0,
    }));

    /* ── employee productivity ───────────────────────────────────────── */
    const employee_productivity = (
      db
        .prepare(
          `SELECT
             assignee_email AS email,
             MAX(assignee_name) AS name,
             COUNT(*) AS total,
             SUM(CASE WHEN ${DONE} THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
             SUM(CASE WHEN due_date != '' AND due_date < ?
                       AND status NOT IN ('completed','approved','cancelled')
                      THEN 1 ELSE 0 END) AS overdue,
             SUM(CASE WHEN ${DONE}
                       AND (due_date = '' OR (completed_at IS NOT NULL AND date(completed_at) <= due_date))
                      THEN 1 ELSE 0 END) AS on_time
           FROM tasks
          WHERE ${rangeTasks} AND assignee_email != ''
          GROUP BY assignee_email ORDER BY total DESC`,
        )
        .all(today, from, to) as any[]
    ).map((r) => ({
      email: r.email,
      name: r.name || r.email,
      total: Number(r.total || 0),
      completed: Number(r.completed || 0),
      approved: Number(r.approved || 0),
      overdue: Number(r.overdue || 0),
      on_time: Number(r.on_time || 0),
      completion_rate: r.total > 0 ? Math.round((r.completed / r.total) * 1000) / 10 : 0,
      on_time_rate: r.completed > 0 ? Math.round((r.on_time / r.completed) * 1000) / 10 : 0,
    }));

    /* ── hygiene audits over time + by area ──────────────────────────── */
    const hygiene_series = (
      db
        .prepare(
          `SELECT date,
                  AVG(score) AS avg_score,
                  SUM(CASE WHEN result = 'pass' THEN 1 ELSE 0 END) AS pass,
                  SUM(CASE WHEN result = 'fail' THEN 1 ELSE 0 END) AS fail,
                  SUM(CASE WHEN result = 'na'   THEN 1 ELSE 0 END) AS na,
                  COUNT(*) AS total
             FROM hygiene_audits WHERE date BETWEEN ? AND ?
            GROUP BY date ORDER BY date ASC`,
        )
        .all(from, to) as any[]
    ).map((r) => ({
      date: r.date,
      avg_score: r.avg_score != null ? Math.round(Number(r.avg_score) * 10) / 10 : 0,
      pass: Number(r.pass || 0),
      fail: Number(r.fail || 0),
      na: Number(r.na || 0),
      total: Number(r.total || 0),
    }));

    const hygiene_by_area = (
      db
        .prepare(
          `SELECT area,
                  AVG(score) AS avg_score,
                  SUM(CASE WHEN result = 'pass' THEN 1 ELSE 0 END) AS pass,
                  SUM(CASE WHEN result = 'fail' THEN 1 ELSE 0 END) AS fail,
                  COUNT(*) AS total
             FROM hygiene_audits WHERE date BETWEEN ? AND ?
            GROUP BY area ORDER BY total DESC`,
        )
        .all(from, to) as any[]
    ).map((r) => ({
      area: r.area || '(Unspecified)',
      avg_score: r.avg_score != null ? Math.round(Number(r.avg_score) * 10) / 10 : 0,
      pass: Number(r.pass || 0),
      fail: Number(r.fail || 0),
      total: Number(r.total || 0),
      pass_rate: r.total > 0 ? Math.round((r.pass / r.total) * 1000) / 10 : 0,
    }));

    /* ── maintenance compliance ──────────────────────────────────────── */
    const maint_by_freq = (
      db
        .prepare(
          `SELECT s.frequency AS frequency,
                  COUNT(DISTINCT s.id) AS active,
                  COUNT(DISTINCT CASE WHEN l.id IS NOT NULL THEN s.id END) AS done
             FROM maintenance_schedules s
             LEFT JOIN maintenance_logs l
               ON l.schedule_id = s.id AND l.status = 'done'
              AND l.performed_at != '' AND date(l.performed_at) BETWEEN ? AND ?
            WHERE s.is_active = 1
            GROUP BY s.frequency`,
        )
        .all(from, to) as any[]
    ).map((r) => ({
      frequency: r.frequency,
      active: Number(r.active || 0),
      done: Number(r.done || 0),
      compliance_rate: r.active > 0 ? Math.round((r.done / r.active) * 1000) / 10 : 0,
    }));

    const maintActive = maint_by_freq.reduce((s, r) => s + r.active, 0);
    const maintDone = maint_by_freq.reduce((s, r) => s + r.done, 0);
    const logsRow = db
      .prepare(
        `SELECT COUNT(*) AS c FROM maintenance_logs
          WHERE status = 'done' AND performed_at != '' AND date(performed_at) BETWEEN ? AND ?`,
      )
      .get(from, to) as any;
    const maintenance = {
      schedules_active: maintActive,
      schedules_done: maintDone,
      logs_done: Number(logsRow?.c || 0),
      compliance_rate: maintActive > 0 ? Math.round((maintDone / maintActive) * 1000) / 10 : 0,
      by_frequency: maint_by_freq,
    };

    /* ── training completion ─────────────────────────────────────────── */
    const trainingRows = db
      .prepare(
        `SELECT status, attendees_json FROM training_sessions
          WHERE session_date != '' AND date(session_date) BETWEEN ? AND ?`,
      )
      .all(from, to) as any[];
    let trAttendees = 0;
    const trCounts = { scheduled: 0, completed: 0, cancelled: 0 };
    for (const r of trainingRows) {
      if (r.status === 'completed') trCounts.completed++;
      else if (r.status === 'cancelled') trCounts.cancelled++;
      else trCounts.scheduled++;
      try {
        const arr = JSON.parse(r.attendees_json || '[]');
        if (Array.isArray(arr)) trAttendees += arr.length;
      } catch {
        /* ignore malformed attendee lists */
      }
    }
    const trTotal = trainingRows.length;
    const training = {
      total: trTotal,
      scheduled: trCounts.scheduled,
      completed: trCounts.completed,
      cancelled: trCounts.cancelled,
      attendees: trAttendees,
      completion_rate: trTotal > 0 ? Math.round((trCounts.completed / trTotal) * 1000) / 10 : 0,
    };

    /* ── knowledge tests ─────────────────────────────────────────────── */
    const ktRow = db
      .prepare(
        `SELECT COUNT(*) AS attempts,
                SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS passed,
                AVG(score) AS avg_score
           FROM knowledge_test_results
          WHERE date(COALESCE(NULLIF(taken_at,''), created_at)) BETWEEN ? AND ?`,
      )
      .get(from, to) as any;
    const ktActive = db
      .prepare(`SELECT COUNT(*) AS c FROM knowledge_tests WHERE is_active = 1`)
      .get() as any;
    const ktAttempts = Number(ktRow?.attempts || 0);
    const ktPassed = Number(ktRow?.passed || 0);
    const knowledge = {
      tests_active: Number(ktActive?.c || 0),
      attempts: ktAttempts,
      passed: ktPassed,
      avg_score: ktRow?.avg_score != null ? Math.round(Number(ktRow.avg_score) * 10) / 10 : 0,
      pass_rate: ktAttempts > 0 ? Math.round((ktPassed / ktAttempts) * 1000) / 10 : 0,
    };

    /* ── overdue analysis (current state, not range-bound) ───────────── */
    const overdue = (
      db
        .prepare(
          `SELECT id, title, department, category, priority, status,
                  assignee_name, assignee_email, due_date
             FROM tasks
            WHERE is_archived = 0 AND due_date != '' AND due_date < ?
              AND status NOT IN ('completed','approved','cancelled')
            ORDER BY due_date ASC LIMIT 200`,
        )
        .all(today) as any[]
    ).map((r) => ({
      ...r,
      assignee_name: r.assignee_name || r.assignee_email || '',
      days_overdue: Math.max(0, daysBetween(r.due_date, today)),
    }));

    return Response.json({
      range: { from, to, period, days: daysBetween(from, to) + 1 },
      summary,
      status_breakdown,
      priority_breakdown,
      category_breakdown,
      period_series,
      department_performance,
      employee_productivity,
      hygiene_series,
      hygiene_by_area,
      maintenance,
      training,
      knowledge,
      overdue,
      generated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('GET /api/tasks/reports failed:', e);
    return Response.json({ error: e?.message || 'Failed to build report' }, { status: 500 });
  }
}
