/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canManageTasks } from '@/lib/tasks';

/**
 * Task Departments (/api/tasks/departments).
 *
 * The task-module's own department registry (task_departments) — distinct from
 * the app's operational `departments` table. Each row carries live task stats
 * computed by SQL against the tasks table (matched by tasks.department = name).
 *
 * GET  /api/tasks/departments?include_inactive=
 *        → { departments: [{ ...dept, stats:{ open, overdue, completed, total } }],
 *            generated_at }
 *          Any signed-in user (stats are operational, not financial).
 *
 * POST /api/tasks/departments   { name, code? }              → create   { department }
 * PUT  /api/tasks/departments   { id, name?, code?, is_active? } → update { department }
 * DELETE /api/tasks/departments?id=                          → deactivate (is_active=0) { ok }
 *
 * Mutations require canManageTasks (admin | manager | head chef | store mgr).
 * Soft-delete only — a department name may still be referenced by historic
 * tasks, so we never hard-delete.
 */
export const dynamic = 'force-dynamic';

/** Statuses considered "still open" (not terminal). */
const OPEN_STATUSES = ['draft', 'assigned', 'accepted', 'in_progress', 'waiting_verification', 'reopened', 'on_hold'];
const DONE_STATUSES = ['completed', 'approved'];

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function placeholders(arr: readonly string[]): string {
  return arr.map(() => '?').join(',');
}

async function requireManager(): Promise<{ me: any } | { resp: Response }> {
  const me = await getCurrentUser();
  if (!me) return { resp: Response.json({ error: 'Sign in required' }, { status: 401 }) };
  if (!canManageTasks(me)) {
    return { resp: Response.json({ error: 'Only managers can manage departments' }, { status: 403 }) };
  }
  return { me };
}

/** Attach live task stats to each department (matched by name). */
function withStats(db: any, depts: any[]) {
  const today = todayISO();
  const openIn = placeholders(OPEN_STATUSES);
  const doneIn = placeholders(DONE_STATUSES);

  const openStmt = db.prepare(
    `SELECT COUNT(*) c FROM tasks WHERE is_archived = 0 AND department = ? AND status IN (${openIn})`,
  );
  const overdueStmt = db.prepare(
    `SELECT COUNT(*) c FROM tasks
      WHERE is_archived = 0 AND department = ? AND due_date != '' AND due_date < ?
        AND status IN (${openIn})`,
  );
  const doneStmt = db.prepare(
    `SELECT COUNT(*) c FROM tasks WHERE is_archived = 0 AND department = ? AND status IN (${doneIn})`,
  );
  const totalStmt = db.prepare(
    `SELECT COUNT(*) c FROM tasks WHERE is_archived = 0 AND department = ?`,
  );

  return depts.map((d) => {
    const open = (openStmt.get(d.name, ...OPEN_STATUSES) as any)?.c ?? 0;
    const overdue = (overdueStmt.get(d.name, today, ...OPEN_STATUSES) as any)?.c ?? 0;
    const completed = (doneStmt.get(d.name, ...DONE_STATUSES) as any)?.c ?? 0;
    const total = (totalStmt.get(d.name) as any)?.c ?? 0;
    return { ...d, stats: { open, overdue, completed, total } };
  });
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  try {
    const url = new URL(request.url);
    const includeInactive = url.searchParams.get('include_inactive') === '1';
    const db = getDb();
    const sql =
      `SELECT * FROM task_departments` +
      (includeInactive ? '' : ` WHERE is_active = 1`) +
      ` ORDER BY is_active DESC, name ASC`;
    const depts = db.prepare(sql).all() as any[];
    return Response.json({ departments: withStats(db, depts), generated_at: new Date().toISOString() });
  } catch (e: any) {
    console.error('GET /api/tasks/departments failed:', e);
    return Response.json({ error: e?.message || 'Failed to load departments' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const g = await requireManager();
  if ('resp' in g) return g.resp;

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const name = String(body?.name || '').trim();
  const code = String(body?.code || '').trim();
  if (!name) return Response.json({ error: 'Department name is required' }, { status: 400 });

  try {
    const db = getDb();
    const dupe = db.prepare(`SELECT id FROM task_departments WHERE name = ? COLLATE NOCASE`).get(name) as any;
    if (dupe) return Response.json({ error: 'A department with that name already exists' }, { status: 409 });

    const id = generateId();
    db.prepare(`INSERT INTO task_departments (id, name, code) VALUES (?, ?, ?)`).run(id, name, code);
    const department = db.prepare(`SELECT * FROM task_departments WHERE id = ?`).get(id);
    return Response.json({ department: { ...(department as any), stats: { open: 0, overdue: 0, completed: 0, total: 0 } } });
  } catch (e: any) {
    console.error('POST /api/tasks/departments failed:', e);
    return Response.json({ error: e?.message || 'Failed to create department' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const g = await requireManager();
  if ('resp' in g) return g.resp;

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const id = String(body?.id || '').trim();
  if (!id) return Response.json({ error: 'Department id is required' }, { status: 400 });

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM task_departments WHERE id = ?`).get(id) as any;
    if (!existing) return Response.json({ error: 'Department not found' }, { status: 404 });

    const sets: string[] = [];
    const args: any[] = [];
    if (body.name !== undefined) {
      const name = String(body.name || '').trim();
      if (!name) return Response.json({ error: 'Department name cannot be empty' }, { status: 400 });
      const dupe = db.prepare(`SELECT id FROM task_departments WHERE name = ? COLLATE NOCASE AND id != ?`).get(name, id) as any;
      if (dupe) return Response.json({ error: 'A department with that name already exists' }, { status: 409 });
      sets.push('name = ?'); args.push(name);
    }
    if (body.code !== undefined) { sets.push('code = ?'); args.push(String(body.code || '').trim()); }
    if (body.is_active !== undefined) { sets.push('is_active = ?'); args.push(body.is_active ? 1 : 0); }
    if (!sets.length) return Response.json({ error: 'Nothing to update' }, { status: 400 });

    sets.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE task_departments SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);

    const [department] = withStats(db, [db.prepare(`SELECT * FROM task_departments WHERE id = ?`).get(id)]);
    return Response.json({ department });
  } catch (e: any) {
    console.error('PUT /api/tasks/departments failed:', e);
    return Response.json({ error: e?.message || 'Failed to update department' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const g = await requireManager();
  if ('resp' in g) return g.resp;

  const url = new URL(request.url);
  const id = String(url.searchParams.get('id') || '').trim();
  if (!id) return Response.json({ error: 'Department id is required' }, { status: 400 });

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT id FROM task_departments WHERE id = ?`).get(id) as any;
    if (!existing) return Response.json({ error: 'Department not found' }, { status: 404 });
    db.prepare(`UPDATE task_departments SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
    return Response.json({ ok: true });
  } catch (e: any) {
    console.error('DELETE /api/tasks/departments failed:', e);
    return Response.json({ error: e?.message || 'Failed to deactivate department' }, { status: 500 });
  }
}
