/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { TASK_STATUSES } from '@/lib/tasks';

/**
 * Kanban board feed (/api/tasks/board) — CORE TASKS slice.
 *
 * GET /api/tasks/board?q=&department=&category=&priority=&assignee=&due=
 *   → { groups: { [status]: Task[] }, counts: { [status]: number } }
 *     Non-archived tasks bucketed by status (every TASK_STATUSES key is present,
 *     empty arrays included). Same filter vocabulary as GET /api/tasks minus the
 *     status filter (the board shows all columns). Within a column: urgent-first,
 *     then due date, then most-recently-updated.
 *
 * Read is open to any signed-in user. Signed-out → 401.
 */
export const dynamic = 'force-dynamic';

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  try {
    const db = getDb();
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') || '').trim();
    const department = (url.searchParams.get('department') || '').trim();
    const category = (url.searchParams.get('category') || '').trim();
    const priority = (url.searchParams.get('priority') || '').trim();
    const assignee = (url.searchParams.get('assignee') || '').trim();
    const due = (url.searchParams.get('due') || '').trim();

    const where: string[] = [`t.is_archived = 0`];
    const params: any[] = [];
    if (q) { where.push(`(t.title LIKE ? OR t.description LIKE ?)`); params.push(`%${q}%`, `%${q}%`); }
    if (department) { where.push(`t.department = ?`); params.push(department); }
    if (category) { where.push(`t.category = ?`); params.push(category); }
    if (priority) { where.push(`t.priority = ?`); params.push(priority); }
    if (assignee) {
      where.push(`(lower(t.assignee_email) = lower(?) OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND lower(ta.user_email) = lower(?)))`);
      params.push(assignee, assignee);
    }
    if (due) {
      const today = todayISO();
      if (due === 'today') { where.push(`t.due_date = ?`); params.push(today); }
      else if (due === 'overdue') { where.push(`t.due_date != '' AND t.due_date < ? AND t.status NOT IN ('completed','approved','cancelled')`); params.push(today); }
      else if (due === 'upcoming') { where.push(`t.due_date != '' AND t.due_date > ?`); params.push(today); }
      else { where.push(`t.due_date = ?`); params.push(due); }
    }

    const rows = db.prepare(`
      SELECT t.* FROM tasks t
      WHERE ${where.join(' AND ')}
      ORDER BY
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        CASE WHEN t.due_date = '' THEN 1 ELSE 0 END, t.due_date ASC,
        t.updated_at DESC
      LIMIT 2000
    `).all(...params) as any[];

    const groups: Record<string, any[]> = {};
    const counts: Record<string, number> = {};
    for (const s of TASK_STATUSES) { groups[s.key] = []; counts[s.key] = 0; }
    for (const t of rows) {
      if (!groups[t.status]) { groups[t.status] = []; counts[t.status] = 0; }
      groups[t.status].push(t);
      counts[t.status]++;
    }

    return Response.json({ groups, counts });
  } catch (e: any) {
    console.error('GET /api/tasks/board failed:', e);
    return Response.json({ error: e?.message || 'Failed to load board' }, { status: 500 });
  }
}
