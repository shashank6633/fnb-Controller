/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * GET /api/tasks/dashboard
 *
 * Live KPI + chart payload for the Task-Management dashboard (/tasks index).
 * Read-only aggregation over the task_* tables — every number is computed by
 * SQL at request time (no caching, no snapshot table).
 *
 * Gate: any signed-in user (401 otherwise). Numbers are operational, not
 * financial, so the whole team may view them. Mutations live in other slices.
 *
 * Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD (Phase 2, default trailing 30 days).
 * Bounds the throughput KPIs — completed, hygiene_*, training_completion_pct,
 * knowledge_completion_pct. State KPIs (due_today, pending, overdue,
 * high_priority, maintenance_*, total_open) stay point-in-time "now".
 *
 * Response shape (see contract_notes):
 *   {
 *     kpis: { due_today, pending, completed, overdue, high_priority,
 *             maintenance_due, maintenance_total, hygiene_score_avg,
 *             hygiene_pass_pct, training_completion_pct,
 *             knowledge_completion_pct, total_open },
 *     by_status:   [{ status, count }],
 *     by_category: [{ category, count }],
 *     dept_performance:      [{ department, total, completed, pending, overdue, completion_pct }],
 *     employee_productivity: [{ assignee_email, assignee_name, total, completed, pending, overdue, completion_pct }],
 *     upcoming:    [{ id, title, priority, status, department, due_date, due_time, assignee_name }],
 *     recent:      [{ id, task_id, title, from_status, to_status, changed_by, note, created_at }],
 *     generated_at,
 *   }
 */
export const dynamic = 'force-dynamic';

/** Statuses considered "still open" (not terminal). */
const OPEN_STATUSES = ['draft', 'assigned', 'accepted', 'in_progress', 'waiting_verification', 'reopened', 'on_hold'];
const DONE_STATUSES = ['completed', 'approved'];

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Build a `?,?,?` placeholder list for an IN() clause. */
function placeholders(arr: readonly string[]): string {
  return arr.map(() => '?').join(',');
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  try {
    const db = getDb();
    const today = todayISO();
    const openIn = placeholders(OPEN_STATUSES);
    const doneIn = placeholders(DONE_STATUSES);

    // ── Date range (Phase 2) ─────────────────────────────────────────────
    // Bounds the "throughput" KPIs (completed, hygiene, training, knowledge).
    // The state KPIs (due_today, pending, overdue, high_priority, maintenance,
    // total_open) remain point-in-time "now" numbers regardless of range.
    // Defaults to a trailing 30-day window (matching /api/tasks/reports).
    const url = new URL(request.url);
    const to = (url.searchParams.get('to') || today).slice(0, 10);
    const defFrom = (() => {
      const d = new Date(to + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 29);
      return d.toISOString().slice(0, 10);
    })();
    const from = (url.searchParams.get('from') || defFrom).slice(0, 10);

    // ── KPI scalars ──────────────────────────────────────────────────────
    const scalar = (sql: string, ...params: any[]): number => {
      const row = db.prepare(sql).get(...params) as { c: number } | undefined;
      return row?.c ?? 0;
    };

    const dueToday = scalar(
      `SELECT COUNT(*) c FROM tasks
        WHERE is_archived = 0 AND due_date = ? AND status IN (${openIn})`,
      today, ...OPEN_STATUSES,
    );

    const pending = scalar(
      `SELECT COUNT(*) c FROM tasks
        WHERE is_archived = 0 AND status IN (${openIn})`,
      ...OPEN_STATUSES,
    );

    // Throughput: tasks whose completion landed inside the selected range.
    const completed = scalar(
      `SELECT COUNT(*) c FROM tasks
        WHERE is_archived = 0 AND status IN (${doneIn})
          AND completed_at IS NOT NULL AND completed_at != ''
          AND date(completed_at) BETWEEN ? AND ?`,
      ...DONE_STATUSES, from, to,
    );

    const overdue = scalar(
      `SELECT COUNT(*) c FROM tasks
        WHERE is_archived = 0 AND due_date != '' AND due_date < ?
          AND status IN (${openIn})`,
      today, ...OPEN_STATUSES,
    );

    const highPriority = scalar(
      `SELECT COUNT(*) c FROM tasks
        WHERE is_archived = 0 AND priority IN ('high','urgent')
          AND status IN (${openIn})`,
      ...OPEN_STATUSES,
    );

    const maintenanceTotal = scalar(
      `SELECT COUNT(*) c FROM maintenance_schedules WHERE is_active = 1`,
    );
    const maintenanceDue = scalar(
      `SELECT COUNT(*) c FROM maintenance_schedules
        WHERE is_active = 1 AND next_due_date != '' AND next_due_date <= ?`,
      today,
    );

    // ── Hygiene score / pass rate (selected range) ───────────────────────
    const hygRow = db.prepare(
      `SELECT
         AVG(score) AS avg_score,
         SUM(CASE WHEN result = 'pass' THEN 1 ELSE 0 END) AS pass_n,
         COUNT(*) AS total_n
       FROM hygiene_audits
       WHERE date BETWEEN ? AND ?`,
    ).get(from, to) as { avg_score: number | null; pass_n: number | null; total_n: number | null };
    const hygieneScoreAvg = Math.round(((hygRow?.avg_score ?? 0) as number) * 10) / 10;
    const hygienePassPct = hygRow?.total_n
      ? Math.round(((hygRow.pass_n ?? 0) / hygRow.total_n) * 100)
      : 0;

    // ── Training completion % (completed / total sessions in range) ──────
    const trainRow = db.prepare(
      `SELECT
         COUNT(*) AS total_n,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS done_n
       FROM training_sessions
       WHERE session_date != '' AND date(session_date) BETWEEN ? AND ?`,
    ).get(from, to) as { total_n: number; done_n: number | null };
    const trainingCompletionPct = trainRow?.total_n
      ? Math.round(((trainRow.done_n ?? 0) / trainRow.total_n) * 100)
      : 0;

    // ── Knowledge-test completion % (passed / attempted results in range) ─
    const ktRow = db.prepare(
      `SELECT
         COUNT(*) AS total_n,
         SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS passed_n
       FROM knowledge_test_results
       WHERE date(COALESCE(NULLIF(taken_at,''), created_at)) BETWEEN ? AND ?`,
    ).get(from, to) as { total_n: number; passed_n: number | null };
    const knowledgeCompletionPct = ktRow?.total_n
      ? Math.round(((ktRow.passed_n ?? 0) / ktRow.total_n) * 100)
      : 0;

    // ── Charts ───────────────────────────────────────────────────────────
    const byStatus = db.prepare(
      `SELECT status, COUNT(*) AS count
         FROM tasks WHERE is_archived = 0
        GROUP BY status ORDER BY count DESC`,
    ).all() as { status: string; count: number }[];

    const byCategory = db.prepare(
      `SELECT category, COUNT(*) AS count
         FROM tasks WHERE is_archived = 0
        GROUP BY category ORDER BY count DESC`,
    ).all() as { category: string; count: number }[];

    // ── Department performance ───────────────────────────────────────────
    const deptPerformance = db.prepare(
      `SELECT
         CASE WHEN department = '' THEN 'Unassigned' ELSE department END AS department,
         COUNT(*) AS total,
         SUM(CASE WHEN status IN (${doneIn}) THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status IN (${openIn}) THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status IN (${openIn}) AND due_date != '' AND due_date < ? THEN 1 ELSE 0 END) AS overdue
       FROM tasks
       WHERE is_archived = 0
       GROUP BY department
       ORDER BY total DESC`,
    ).all(...DONE_STATUSES, ...OPEN_STATUSES, ...OPEN_STATUSES, today) as any[];
    deptPerformance.forEach((r) => {
      r.completion_pct = r.total ? Math.round((r.completed / r.total) * 100) : 0;
    });

    // ── Employee productivity (counts every assignee, not just primary) ──
    // Phase 2: a task with several assignees (task_assignees) now credits each
    // of them. Tasks that predate multi-assignee (no task_assignees rows) fall
    // back to the primary assignee_email mirror so nothing is lost.
    const employeeProductivity = db.prepare(
      `WITH assignee_map AS (
         SELECT ta.task_id AS task_id, lower(ta.user_email) AS email, ta.user_name AS name
           FROM task_assignees ta
          WHERE ta.user_email != ''
         UNION
         SELECT t.id AS task_id, lower(t.assignee_email) AS email, t.assignee_name AS name
           FROM tasks t
          WHERE t.assignee_email != ''
            AND NOT EXISTS (SELECT 1 FROM task_assignees x WHERE x.task_id = t.id AND x.user_email != '')
       )
       SELECT
         am.email AS assignee_email,
         MAX(am.name) AS assignee_name,
         COUNT(*) AS total,
         SUM(CASE WHEN t.status IN (${doneIn}) THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN t.status IN (${openIn}) THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN t.status IN (${openIn}) AND t.due_date != '' AND t.due_date < ? THEN 1 ELSE 0 END) AS overdue
       FROM assignee_map am
       JOIN tasks t ON t.id = am.task_id
       WHERE t.is_archived = 0
       GROUP BY am.email
       ORDER BY total DESC
       LIMIT 15`,
    ).all(...DONE_STATUSES, ...OPEN_STATUSES, ...OPEN_STATUSES, today) as any[];
    employeeProductivity.forEach((r) => {
      r.completion_pct = r.total ? Math.round((r.completed / r.total) * 100) : 0;
    });

    // ── Upcoming scheduled tasks (due today or later, still open) ─────────
    const upcoming = db.prepare(
      `SELECT id, title, priority, status, department, due_date, due_time,
              CASE WHEN assignee_name != '' THEN assignee_name ELSE assignee_email END AS assignee_name
         FROM tasks
        WHERE is_archived = 0 AND status IN (${openIn})
          AND due_date != '' AND due_date >= ?
        ORDER BY due_date ASC, due_time ASC
        LIMIT 8`,
    ).all(...OPEN_STATUSES, today) as any[];

    // ── Recent activity (status changes) ─────────────────────────────────
    const recent = db.prepare(
      `SELECT h.id, h.task_id, t.title AS title, h.from_status, h.to_status,
              h.changed_by, h.note, h.created_at
         FROM task_status_history h
         LEFT JOIN tasks t ON t.id = h.task_id
        ORDER BY h.created_at DESC
        LIMIT 10`,
    ).all() as any[];

    return Response.json({
      kpis: {
        due_today: dueToday,
        pending,
        completed,
        overdue,
        high_priority: highPriority,
        maintenance_due: maintenanceDue,
        maintenance_total: maintenanceTotal,
        hygiene_score_avg: hygieneScoreAvg,
        hygiene_pass_pct: hygienePassPct,
        training_completion_pct: trainingCompletionPct,
        knowledge_completion_pct: knowledgeCompletionPct,
        total_open: pending,
      },
      by_status: byStatus,
      by_category: byCategory,
      dept_performance: deptPerformance,
      employee_productivity: employeeProductivity,
      upcoming,
      recent,
      range: { from, to },
      generated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('tasks/dashboard failed:', e);
    return Response.json({ error: e?.message || 'Failed to load dashboard' }, { status: 500 });
  }
}
