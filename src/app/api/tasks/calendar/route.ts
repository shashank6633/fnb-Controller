import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Task-Management calendar feed — /api/tasks/calendar
 *
 * Read-only. Returns every dated Task-Management entity that falls inside
 * ?from=YYYY-MM-DD&to=YYYY-MM-DD as a flat list of calendar items, each shaped
 * { id, type, title, date, time, status, priority, department, assignee_name,
 *   href, meta }. The page groups them into Day / Week / Month grids and colours
 * them by `type`.
 *
 * Sources & their date column:
 *   - task        : tasks.due_date
 *   - maintenance : maintenance_schedules.next_due_date
 *   - training    : training_sessions.session_date
 *   - hygiene     : hygiene_audits.date
 *   - knowledge   : knowledge_tests.created_at (tests have no schedule date)
 *
 * Access: any signed-in user (calendar is not cross-employee sensitive; it is a
 * planning surface). Mutations live in other slices.
 */
export const dynamic = 'force-dynamic';

const HREF = {
  task: '/tasks/board',
  maintenance: '/tasks/maintenance',
  training: '/tasks/training',
  hygiene: '/tasks/hygiene',
  knowledge: '/tasks/knowledge-tests',
} as const;

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const db = getDb();
    const url = new URL(request.url);
    const today = new Date().toISOString().slice(0, 10);

    // Default window: the calendar month around today (±31d) if none supplied.
    const to = (url.searchParams.get('to') || (() => {
      const d = new Date(today + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 31);
      return d.toISOString().slice(0, 10);
    })()).slice(0, 10);
    const from = (url.searchParams.get('from') || (() => {
      const d = new Date(today + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 31);
      return d.toISOString().slice(0, 10);
    })()).slice(0, 10);

    const typeFilter = (url.searchParams.get('type') || '').toLowerCase();
    const want = (t: string) => !typeFilter || typeFilter === t;

    const items: any[] = [];

    /* ── tasks (by due_date) ─────────────────────────────────────────── */
    if (want('task')) {
      const rows = db
        .prepare(
          `SELECT id, title, due_date, due_time, status, priority, department,
                  assignee_name, assignee_email, category
             FROM tasks
            WHERE is_archived = 0 AND due_date != '' AND due_date BETWEEN ? AND ?
            ORDER BY due_date ASC, due_time ASC LIMIT 1000`,
        )
        .all(from, to) as any[];
      for (const r of rows) {
        items.push({
          id: r.id,
          type: 'task',
          title: r.title,
          date: r.due_date,
          time: r.due_time || '',
          status: r.status,
          priority: r.priority,
          department: r.department || '',
          assignee_name: r.assignee_name || r.assignee_email || '',
          href: `${HREF.task}?focus=${encodeURIComponent(r.id)}`,
          meta: r.category || '',
        });
      }
    }

    /* ── maintenance (by next_due_date) ──────────────────────────────── */
    if (want('maintenance')) {
      const rows = db
        .prepare(
          `SELECT id, name, next_due_date, frequency, department, assignee_email
             FROM maintenance_schedules
            WHERE is_active = 1 AND next_due_date != '' AND next_due_date BETWEEN ? AND ?
            ORDER BY next_due_date ASC LIMIT 1000`,
        )
        .all(from, to) as any[];
      for (const r of rows) {
        items.push({
          id: r.id,
          type: 'maintenance',
          title: r.name,
          date: r.next_due_date,
          time: '',
          status: 'scheduled',
          priority: 'medium',
          department: r.department || 'Maintenance',
          assignee_name: r.assignee_email || '',
          href: HREF.maintenance,
          meta: r.frequency || '',
        });
      }
    }

    /* ── training (by session_date) ──────────────────────────────────── */
    if (want('training')) {
      const rows = db
        .prepare(
          `SELECT id, title, session_date, status, department, trainer, duration_minutes
             FROM training_sessions
            WHERE session_date != '' AND session_date BETWEEN ? AND ?
            ORDER BY session_date ASC LIMIT 1000`,
        )
        .all(from, to) as any[];
      for (const r of rows) {
        items.push({
          id: r.id,
          type: 'training',
          title: r.title,
          date: r.session_date,
          time: '',
          status: r.status || 'scheduled',
          priority: 'medium',
          department: r.department || '',
          assignee_name: r.trainer || '',
          href: HREF.training,
          meta: r.duration_minutes ? `${r.duration_minutes} min` : '',
        });
      }
    }

    /* ── hygiene audits (by date) ────────────────────────────────────── */
    if (want('hygiene')) {
      const rows = db
        .prepare(
          `SELECT id, area, item, date, result, score, auditor
             FROM hygiene_audits
            WHERE date != '' AND date BETWEEN ? AND ?
            ORDER BY date ASC LIMIT 1000`,
        )
        .all(from, to) as any[];
      for (const r of rows) {
        items.push({
          id: r.id,
          type: 'hygiene',
          title: `${r.area || 'Hygiene'}${r.item ? ' — ' + r.item : ''}`,
          date: r.date,
          time: '',
          status: r.result || 'na',
          priority: r.result === 'fail' ? 'high' : 'low',
          department: r.area || '',
          assignee_name: r.auditor || '',
          href: HREF.hygiene,
          meta: r.score != null ? `Score ${r.score}` : '',
        });
      }
    }

    /* ── knowledge tests (by created_at) ─────────────────────────────── */
    if (want('knowledge')) {
      const rows = db
        .prepare(
          `SELECT id, title, created_at, pass_score, time_limit_minutes
             FROM knowledge_tests
            WHERE is_active = 1 AND date(created_at) BETWEEN ? AND ?
            ORDER BY created_at ASC LIMIT 1000`,
        )
        .all(from, to) as any[];
      for (const r of rows) {
        items.push({
          id: r.id,
          type: 'knowledge',
          title: r.title,
          date: String(r.created_at || '').slice(0, 10),
          time: '',
          status: 'active',
          priority: 'medium',
          department: '',
          assignee_name: '',
          href: HREF.knowledge,
          meta: r.pass_score ? `Pass ${r.pass_score}%` : '',
        });
      }
    }

    // Stable ordering: date, then type.
    items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.type < b.type ? -1 : 1));

    // Per-type counts for the page's filter chips.
    const counts: Record<string, number> = {};
    for (const it of items) counts[it.type] = (counts[it.type] || 0) + 1;

    return Response.json({ range: { from, to }, items, counts, total: items.length });
  } catch (e: any) {
    console.error('GET /api/tasks/calendar failed:', e);
    return Response.json({ error: e?.message || 'Failed to build calendar' }, { status: 500 });
  }
}
