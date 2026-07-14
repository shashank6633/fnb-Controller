/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canManageTasks, TASK_STATUSES, TASK_PRIORITIES } from '@/lib/tasks';
import { notifyTaskAssignment } from '@/lib/task-automation';

/**
 * Tasks collection (/api/tasks) — CORE TASKS slice.
 *
 * GET  /api/tasks?q=&status=&department=&category=&priority=&assignee=&due=&page=&pageSize=&include_archived=
 *        → { rows: Task[], total, page, pageSize }
 *        Filters (all optional, AND-combined):
 *          q          — title/description LIKE fragment
 *          status     — one status, or a comma-separated set (IN)
 *          department — exact task_departments.name
 *          category   — exact task_categories.name
 *          priority   — low|medium|high|urgent
 *          assignee   — email; matches tasks.assignee_email OR any task_assignees row
 *          mentioned  — email; tasks that have a task_mentions row for this email
 *          due        — 'today' | 'overdue' | 'upcoming' | a specific YYYY-MM-DD
 *          include_archived — '1' to include is_archived=1 rows (default excludes)
 *        Ordered urgent-first, then by due date, then most-recently-updated.
 *        Read is open to any signed-in user (task visibility is app-wide).
 *
 * POST /api/tasks  { title*, description?, category?, department?, priority?,
 *                    status?, assignees?[], assignee_email?, assignee_name?,
 *                    created_by?, due_date?, due_time?, estimated_minutes?,
 *                    parent_task_id?, template_id?, recurring_rule_id?,
 *                    source?, checklist?[] }
 *        → { task } — creates a task, mirrors the assignee list into
 *          task_assignees, seeds task_status_history (''→status) and notifies
 *          each assignee. Gate: canManageTasks.
 *
 * CSRF on POST is enforced by proxy.ts (/api/tasks prefix).
 */
export const dynamic = 'force-dynamic';

const VALID_STATUSES = new Set(TASK_STATUSES.map((s) => s.key as string));
const VALID_PRIORITIES = new Set(TASK_PRIORITIES.map((p) => p.key as string));

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Normalize the incoming assignees payload into [{email,name}]. Accepts an
 *  array of {email,name} objects, an array of email strings, or falls back to
 *  the single assignee_email/assignee_name fields. De-duped by lowercase email. */
function normalizeAssignees(body: any): { email: string; name: string }[] {
  const out: { email: string; name: string }[] = [];
  const seen = new Set<string>();
  const push = (email: any, name: any) => {
    const e = String(email ?? '').trim();
    if (!e) return;
    const key = e.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ email: e, name: String(name ?? '').trim() });
  };
  if (Array.isArray(body?.assignees)) {
    for (const a of body.assignees) {
      if (a && typeof a === 'object') push(a.email, a.name);
      else push(a, '');
    }
  }
  // Single-field fallback / addition.
  if (body?.assignee_email) push(body.assignee_email, body.assignee_name);
  return out;
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  try {
    const db = getDb();
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') || '').trim();
    const status = (url.searchParams.get('status') || '').trim();
    const department = (url.searchParams.get('department') || '').trim();
    const category = (url.searchParams.get('category') || '').trim();
    const priority = (url.searchParams.get('priority') || '').trim();
    const assignee = (url.searchParams.get('assignee') || '').trim();
    const mentioned = (url.searchParams.get('mentioned') || '').trim();
    const due = (url.searchParams.get('due') || '').trim();
    const includeArchived = url.searchParams.get('include_archived') === '1';

    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(url.searchParams.get('pageSize') || '20', 10) || 20));

    const where: string[] = [];
    const params: any[] = [];
    if (!includeArchived) where.push(`t.is_archived = 0`);
    if (q) { where.push(`(t.title LIKE ? OR t.description LIKE ?)`); params.push(`%${q}%`, `%${q}%`); }
    if (status) {
      const list = status.split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length === 1) { where.push(`t.status = ?`); params.push(list[0]); }
      else if (list.length > 1) { where.push(`t.status IN (${list.map(() => '?').join(',')})`); params.push(...list); }
    }
    if (department) { where.push(`t.department = ?`); params.push(department); }
    if (category) { where.push(`t.category = ?`); params.push(category); }
    if (priority) { where.push(`t.priority = ?`); params.push(priority); }
    if (assignee) {
      where.push(`(lower(t.assignee_email) = lower(?) OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND lower(ta.user_email) = lower(?)))`);
      params.push(assignee, assignee);
    }
    if (mentioned) {
      where.push(`EXISTS (SELECT 1 FROM task_mentions tm WHERE tm.task_id = t.id AND lower(tm.mentioned_email) = lower(?))`);
      params.push(mentioned);
    }
    if (due) {
      const today = todayISO();
      if (due === 'today') { where.push(`t.due_date = ?`); params.push(today); }
      else if (due === 'overdue') {
        where.push(`t.due_date != '' AND t.due_date < ? AND t.status NOT IN ('completed','approved','cancelled')`);
        params.push(today);
      } else if (due === 'upcoming') { where.push(`t.due_date != '' AND t.due_date > ?`); params.push(today); }
      else { where.push(`t.due_date = ?`); params.push(due); }
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM tasks t ${whereSql}`).get(...params) as any).n as number;

    const rows = db.prepare(`
      SELECT t.* FROM tasks t
      ${whereSql}
      ORDER BY
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        CASE WHEN t.due_date = '' THEN 1 ELSE 0 END, t.due_date ASC,
        t.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize) as any[];

    return Response.json({ rows, total, page, pageSize });
  } catch (e: any) {
    console.error('GET /api/tasks failed:', e);
    return Response.json({ error: e?.message || 'Failed to load tasks' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageTasks(me)) {
    return Response.json({ error: 'Not authorised to create tasks' }, { status: 403 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }

  const title = String(body?.title ?? '').trim();
  if (!title) return Response.json({ error: 'title is required' }, { status: 400 });

  const status = String(body?.status ?? 'draft').trim() || 'draft';
  if (!VALID_STATUSES.has(status)) {
    return Response.json({ error: `invalid status '${status}'` }, { status: 400 });
  }
  const priority = String(body?.priority ?? 'medium').trim() || 'medium';
  if (!VALID_PRIORITIES.has(priority)) {
    return Response.json({ error: `invalid priority '${priority}'` }, { status: 400 });
  }

  const assignees = normalizeAssignees(body);
  const primary = assignees[0] || { email: '', name: '' };

  // Inline checklist → JSON. Accept [{label,done}] or [string].
  let checklistJson = '[]';
  if (Array.isArray(body?.checklist)) {
    const items = body.checklist
      .map((c: any) => (c && typeof c === 'object')
        ? { label: String(c.label ?? '').trim(), done: !!c.done }
        : { label: String(c ?? '').trim(), done: false })
      .filter((c: any) => c.label);
    checklistJson = JSON.stringify(items);
  } else if (typeof body?.checklist_json === 'string') {
    checklistJson = body.checklist_json;
  }

  try {
    const db = getDb();
    const id = generateId();
    const actorEmail = me.email || '';
    const actorName = me.name || me.email || '';
    const createdBy = String(body?.created_by ?? '').trim() || actorEmail;

    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO tasks (
          id, title, description, category, department, priority, status,
          assignee_email, assignee_name, created_by, due_date, due_time,
          estimated_minutes, parent_task_id, recurring_rule_id, template_id,
          source, checklist_json, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, title,
        String(body?.description ?? '').trim(),
        String(body?.category ?? 'Operations').trim() || 'Operations',
        String(body?.department ?? '').trim(),
        priority, status,
        primary.email, primary.name, createdBy,
        String(body?.due_date ?? '').trim(),
        String(body?.due_time ?? '').trim(),
        Number.isFinite(+body?.estimated_minutes) ? Math.max(0, Math.trunc(+body.estimated_minutes)) : 0,
        String(body?.parent_task_id ?? '').trim(),
        String(body?.recurring_rule_id ?? '').trim(),
        String(body?.template_id ?? '').trim(),
        String(body?.source ?? 'manual').trim() || 'manual',
        checklistJson,
        Number.isFinite(+body?.sort_order) ? Math.trunc(+body.sort_order) : 0,
      );

      for (const a of assignees) {
        db.prepare(`INSERT INTO task_assignees (id, task_id, user_email, user_name) VALUES (?, ?, ?, ?)`)
          .run(generateId(), id, a.email, a.name);
      }

      db.prepare(`INSERT INTO task_status_history (id, task_id, from_status, to_status, changed_by, note) VALUES (?, ?, '', ?, ?, ?)`)
        .run(generateId(), id, status, actorEmail, 'Task created');

      // Notify each assignee (unless assigning to self), via the shared automation
      // helper so create-time and generator-time assignment alerts stay identical.
      for (const a of assignees) {
        if (a.email.toLowerCase() === actorEmail.toLowerCase()) continue;
        notifyTaskAssignment(db, id, a.email, actorName);
      }
    });
    tx();

    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as any;
    return Response.json({ task }, { status: 201 });
  } catch (e: any) {
    console.error('POST /api/tasks failed:', e);
    return Response.json({ error: e?.message || 'Failed to create task' }, { status: 500 });
  }
}
