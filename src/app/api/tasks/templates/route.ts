/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canManageTasks } from '@/lib/tasks';
import { sendPushToUser } from '@/lib/push';

/**
 * Best-effort web-push mirroring a just-inserted task_notification. Deferred to
 * a microtask so it runs after any surrounding better-sqlite3 transaction
 * commits and can never block or break the insert. sendPushToUser never throws.
 */
function firePush(
  db: ReturnType<typeof getDb>,
  email: string,
  payload: { title: string; body: string; url?: string },
): void {
  try {
    if (!email) return;
    Promise.resolve().then(() => sendPushToUser(db, email, payload)).catch(() => {});
  } catch {
    /* never throw */
  }
}

/**
 * Checklist / reusable-task Templates (/api/tasks/templates).
 *
 * GET  /api/tasks/templates?role=&department=&q=&include_archived=
 *        → { templates: [{ ...tpl, items:[...], item_count }] }
 *          Lists checklist_templates with their ordered checklist_items. By
 *          default only is_active=1 templates; pass include_archived=1 to see
 *          archived ones too. Any signed-in user (staff run the checklists).
 *
 * POST /api/tasks/templates
 *        { name, role?, department?, category?, items:[{label,requires_image?}] }
 *          → create a template + items. { template }
 *        { action:'duplicate', template_id }
 *          → deep-copy a template + items ("(copy)"). { template }
 *        { action:'create_task', template_id, assignee_email?, assignee_name?,
 *          department?, due_date?, due_time?, priority?, category? }
 *          → materialise a one-off task from the template (checklist_json filled
 *            from its items). { task_id }
 *
 * PUT  /api/tasks/templates   { id, name?, role?, department?, category?,
 *        is_active?, items? } — if items[] supplied they REPLACE existing items.
 *        { template }
 *
 * DELETE /api/tasks/templates?id=   → archive (is_active=0). { ok:true }
 *
 * Mutations require canManageTasks (admin | manager | head chef | store mgr).
 */
export const dynamic = 'force-dynamic';

async function requireManager(): Promise<{ me: any } | { resp: Response }> {
  const me = await getCurrentUser();
  if (!me) return { resp: Response.json({ error: 'Sign in required' }, { status: 401 }) };
  if (!canManageTasks(me)) {
    return { resp: Response.json({ error: 'Only managers can manage templates' }, { status: 403 }) };
  }
  return { me };
}

/** Load a template row with its ordered items. */
function loadTemplate(db: any, id: string) {
  const tpl = db.prepare(`SELECT * FROM checklist_templates WHERE id = ?`).get(id) as any;
  if (!tpl) return null;
  const items = db
    .prepare(`SELECT * FROM checklist_items WHERE template_id = ? ORDER BY sort_order ASC, created_at ASC`)
    .all(id) as any[];
  return { ...tpl, items, item_count: items.length };
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  try {
    const url = new URL(request.url);
    const role = (url.searchParams.get('role') || '').trim();
    const department = (url.searchParams.get('department') || '').trim();
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const includeArchived = url.searchParams.get('include_archived') === '1';

    const db = getDb();
    const where: string[] = [];
    const args: any[] = [];
    if (!includeArchived) where.push('is_active = 1');
    if (role) { where.push('role = ?'); args.push(role); }
    if (department) { where.push('department = ?'); args.push(department); }
    const sql =
      `SELECT * FROM checklist_templates` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY is_active DESC, name ASC`;
    let tpls = db.prepare(sql).all(...args) as any[];
    if (q) tpls = tpls.filter((t) => `${t.name} ${t.role} ${t.department} ${t.category}`.toLowerCase().includes(q));

    const itemsStmt = db.prepare(
      `SELECT * FROM checklist_items WHERE template_id = ? ORDER BY sort_order ASC, created_at ASC`,
    );
    const templates = tpls.map((t) => {
      const items = itemsStmt.all(t.id) as any[];
      return { ...t, items, item_count: items.length };
    });
    return Response.json({ templates });
  } catch (e: any) {
    console.error('GET /api/tasks/templates failed:', e);
    return Response.json({ error: e?.message || 'Failed to load templates' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const g = await requireManager();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const action = String(body?.action || '').trim();

  try {
    const db = getDb();

    /* ── duplicate an existing template ── */
    if (action === 'duplicate') {
      const srcId = String(body?.template_id || '').trim();
      const src = loadTemplate(db, srcId);
      if (!src) return Response.json({ error: 'Template not found' }, { status: 404 });
      const newId = generateId();
      db.prepare(
        `INSERT INTO checklist_templates (id, name, role, department, category, is_active) VALUES (?, ?, ?, ?, ?, 1)`,
      ).run(newId, `${src.name} (copy)`, src.role, src.department, src.category);
      const insItem = db.prepare(
        `INSERT INTO checklist_items (id, template_id, label, sort_order, requires_image) VALUES (?, ?, ?, ?, ?)`,
      );
      src.items.forEach((it: any, i: number) =>
        insItem.run(generateId(), newId, it.label, i, it.requires_image ? 1 : 0),
      );
      return Response.json({ template: loadTemplate(db, newId) });
    }

    /* ── create a one-off task from a template ── */
    if (action === 'create_task') {
      const srcId = String(body?.template_id || '').trim();
      const src = loadTemplate(db, srcId);
      if (!src) return Response.json({ error: 'Template not found' }, { status: 404 });

      const assigneeEmail = String(body?.assignee_email ?? '').trim();
      const assigneeName = String(body?.assignee_name ?? '').trim();
      const department = String(body?.department ?? src.department ?? '').trim();
      const category = String(body?.category ?? src.category ?? 'Operations').trim();
      const priority = String(body?.priority ?? 'medium').trim();
      const dueDate = String(body?.due_date ?? '').trim();
      const dueTime = String(body?.due_time ?? '').trim();

      const checklist = src.items.map((it: any) => ({
        label: it.label,
        requires_image: !!it.requires_image,
        done: false,
      }));
      const status = assigneeEmail ? 'assigned' : 'draft';
      const taskId = generateId();
      db.prepare(
        `INSERT INTO tasks
           (id, title, description, category, department, priority, status,
            assignee_email, assignee_name, created_by, due_date, due_time,
            source, template_id, checklist_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'checklist', ?, ?)`,
      ).run(
        taskId, src.name, '', category, department, priority, status,
        assigneeEmail, assigneeName, me.email || me.name || '', dueDate, dueTime,
        srcId, JSON.stringify(checklist),
      );
      db.prepare(
        `INSERT INTO task_status_history (id, task_id, from_status, to_status, changed_by, note)
         VALUES (?, ?, '', ?, ?, ?)`,
      ).run(generateId(), taskId, status, me.email || me.name || '', 'Created from template');

      if (assigneeEmail) {
        db.prepare(
          `INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href)
           VALUES (?, ?, 'assignment', ?, ?, ?, ?)`,
        ).run(
          generateId(), assigneeEmail, `Task assigned: ${src.name}`,
          `You have been assigned "${src.name}"`, taskId, `/tasks/my`,
        );
        firePush(db, assigneeEmail, { title: `Task assigned: ${src.name}`, body: `You have been assigned "${src.name}"`, url: '/tasks/my' });
      }
      return Response.json({ task_id: taskId });
    }

    /* ── create a fresh template ── */
    const name = String(body?.name ?? '').trim();
    if (!name) return Response.json({ error: 'Template name required' }, { status: 400 });
    const role = String(body?.role ?? '').trim();
    const department = String(body?.department ?? '').trim();
    const category = String(body?.category ?? 'Operations').trim() || 'Operations';
    const items: any[] = Array.isArray(body?.items) ? body.items : [];

    const id = generateId();
    db.prepare(
      `INSERT INTO checklist_templates (id, name, role, department, category, is_active) VALUES (?, ?, ?, ?, ?, 1)`,
    ).run(id, name, role, department, category);
    const insItem = db.prepare(
      `INSERT INTO checklist_items (id, template_id, label, sort_order, requires_image) VALUES (?, ?, ?, ?, ?)`,
    );
    items
      .map((it) => (typeof it === 'string' ? { label: it } : it))
      .filter((it) => it && String(it.label ?? '').trim())
      .forEach((it, i) => insItem.run(generateId(), id, String(it.label).trim(), i, it.requires_image ? 1 : 0));

    return Response.json({ template: loadTemplate(db, id) });
  } catch (e: any) {
    console.error('POST /api/tasks/templates failed:', e);
    return Response.json({ error: e?.message || 'Failed to save template' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const g = await requireManager();
  if ('resp' in g) return g.resp;

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const id = String(body?.id ?? '').trim();
  if (!id) return Response.json({ error: 'Template id required' }, { status: 400 });

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM checklist_templates WHERE id = ?`).get(id) as any;
    if (!existing) return Response.json({ error: 'Template not found' }, { status: 404 });

    const name = body?.name != null ? String(body.name).trim() : existing.name;
    if (!name) return Response.json({ error: 'Template name cannot be empty' }, { status: 400 });
    const role = body?.role != null ? String(body.role).trim() : existing.role;
    const department = body?.department != null ? String(body.department).trim() : existing.department;
    const category = body?.category != null ? (String(body.category).trim() || 'Operations') : existing.category;
    const isActive = body?.is_active != null ? (body.is_active ? 1 : 0) : existing.is_active;

    db.prepare(
      `UPDATE checklist_templates
         SET name=?, role=?, department=?, category=?, is_active=?, updated_at=datetime('now')
       WHERE id=?`,
    ).run(name, role, department, category, isActive, id);

    // Replace items only when the caller explicitly sends an items array.
    if (Array.isArray(body?.items)) {
      db.prepare(`DELETE FROM checklist_items WHERE template_id = ?`).run(id);
      const insItem = db.prepare(
        `INSERT INTO checklist_items (id, template_id, label, sort_order, requires_image) VALUES (?, ?, ?, ?, ?)`,
      );
      body.items
        .map((it: any) => (typeof it === 'string' ? { label: it } : it))
        .filter((it: any) => it && String(it.label ?? '').trim())
        .forEach((it: any, i: number) =>
          insItem.run(generateId(), id, String(it.label).trim(), i, it.requires_image ? 1 : 0),
        );
    }
    return Response.json({ template: loadTemplate(db, id) });
  } catch (e: any) {
    console.error('PUT /api/tasks/templates failed:', e);
    return Response.json({ error: e?.message || 'Failed to update template' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const g = await requireManager();
  if ('resp' in g) return g.resp;
  try {
    const url = new URL(request.url);
    let id = (url.searchParams.get('id') || '').trim();
    if (!id) { try { id = String((await request.json())?.id || '').trim(); } catch { /* noop */ } }
    if (!id) return Response.json({ error: 'Template id required' }, { status: 400 });

    const db = getDb();
    const existing = db.prepare(`SELECT id FROM checklist_templates WHERE id = ?`).get(id) as any;
    if (!existing) return Response.json({ error: 'Template not found' }, { status: 404 });
    // Soft archive (checklist_templates has no is_archived — is_active=0 is the archive flag).
    db.prepare(`UPDATE checklist_templates SET is_active=0, updated_at=datetime('now') WHERE id=?`).run(id);
    return Response.json({ ok: true });
  } catch (e: any) {
    console.error('DELETE /api/tasks/templates failed:', e);
    return Response.json({ error: e?.message || 'Failed to archive template' }, { status: 500 });
  }
}
