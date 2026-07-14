/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, requireRole } from '@/lib/auth';
import { TASK_PRIORITIES } from '@/lib/tasks';

/**
 * Task-Module Settings (/api/tasks/settings).
 *
 * The admin config surface for the whole task module. Scalar / structured config
 * lives in the shared settings KV table under `tm_*` keys (JSON-encoded), while
 * the categories vocabulary lives in its own task_categories table.
 *
 * GET  /api/tasks/settings   → {
 *        categories:  [...task_categories],
 *        priorities:  [...],            // tm_priorities override or TASK_PRIORITIES
 *        config: {
 *          approval_levels:        [{ name, min_priority, approver_role }],
 *          notification_rules:     { on_assign, on_mention, on_status_change,
 *                                    on_overdue, on_approval, daily_digest },
 *          escalation_matrix:      [{ priority, hours, escalate_to }],
 *          working_hours:          { start, end, days:[0..6] },
 *          holidays:               [{ date, name }],
 *          reminder_interval_hours: number,
 *        },
 *        recurring: { rules:[...recurring_task_rules], rule_count,
 *                     maintenance_count },
 *      }
 *      Any signed-in user may READ config (pages need it to render pickers).
 *
 * PUT  /api/tasks/settings   { config?: {...partial}, priorities?: [...] }
 *        → persist scalar config + priority-label overrides. Admin only.
 * POST /api/tasks/settings   { name, color?, icon? }        → create category. Admin only.
 * PATCH /api/tasks/settings  { id, name?, color?, icon?, sort_order?, is_active? }
 *        → update a category. Admin only.
 * DELETE /api/tasks/settings?id=  → deactivate a category (is_active=0). Admin only.
 *
 * Categories/config are global system config → admin-only writes (requireRole).
 */
export const dynamic = 'force-dynamic';

/* ── config KV keys + defaults ─────────────────────────────────────────── */

const KEYS = {
  approval_levels: 'tm_approval_levels',
  notification_rules: 'tm_notification_rules',
  escalation_matrix: 'tm_escalation_matrix',
  working_hours: 'tm_working_hours',
  holidays: 'tm_holidays',
  reminder_interval_hours: 'tm_reminder_interval_hours',
  priorities: 'tm_priorities',
} as const;

const DEFAULTS = {
  approval_levels: [
    { name: 'Manager Approval', min_priority: 'medium', approver_role: 'manager' },
  ],
  notification_rules: {
    on_assign: true,
    on_mention: true,
    on_status_change: true,
    on_overdue: true,
    on_approval: true,
    daily_digest: false,
  },
  escalation_matrix: [
    { priority: 'urgent', hours: 2, escalate_to: '' },
    { priority: 'high', hours: 8, escalate_to: '' },
  ],
  working_hours: { start: '09:00', end: '23:00', days: [1, 2, 3, 4, 5, 6, 0] },
  holidays: [] as { date: string; name: string }[],
  reminder_interval_hours: 24,
};

function readJson<T>(db: any, key: string, fallback: T): T {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value?: string } | undefined;
    if (!row?.value) return fallback;
    const parsed = JSON.parse(row.value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeKv(db: any, key: string, value: any) {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, JSON.stringify(value));
}

/** Default priority list (labels/colors) — editable copy of TASK_PRIORITIES. */
function defaultPriorities() {
  return TASK_PRIORITIES.map((p) => ({ key: p.key, label: p.label, color: p.color }));
}

async function requireAdmin(): Promise<{ me: any } | { resp: Response }> {
  const res = await requireRole('admin');
  if (!res.ok) return { resp: Response.json({ error: res.message }, { status: res.status }) };
  return { me: res.user };
}

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  try {
    const db = getDb();

    const categories = db
      .prepare(`SELECT * FROM task_categories ORDER BY is_active DESC, sort_order ASC, name ASC`)
      .all() as any[];

    const priorities = readJson(db, KEYS.priorities, defaultPriorities());

    const config = {
      approval_levels: readJson(db, KEYS.approval_levels, DEFAULTS.approval_levels),
      notification_rules: { ...DEFAULTS.notification_rules, ...readJson(db, KEYS.notification_rules, {}) },
      escalation_matrix: readJson(db, KEYS.escalation_matrix, DEFAULTS.escalation_matrix),
      working_hours: { ...DEFAULTS.working_hours, ...readJson(db, KEYS.working_hours, {}) },
      holidays: readJson(db, KEYS.holidays, DEFAULTS.holidays),
      reminder_interval_hours: Number(readJson(db, KEYS.reminder_interval_hours, DEFAULTS.reminder_interval_hours)) || DEFAULTS.reminder_interval_hours,
    };

    const rules = db
      .prepare(`SELECT * FROM recurring_task_rules WHERE is_active = 1 ORDER BY title ASC`)
      .all() as any[];
    const maint = db.prepare(`SELECT COUNT(*) c FROM maintenance_schedules WHERE is_active = 1`).get() as any;

    return Response.json({
      categories,
      priorities,
      config,
      recurring: { rules, rule_count: rules.length, maintenance_count: maint?.c ?? 0 },
    });
  } catch (e: any) {
    console.error('GET /api/tasks/settings failed:', e);
    return Response.json({ error: e?.message || 'Failed to load settings' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const g = await requireAdmin();
  if ('resp' in g) return g.resp;

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }

  try {
    const db = getDb();
    const config = body?.config;
    if (config && typeof config === 'object') {
      if (config.approval_levels !== undefined) writeKv(db, KEYS.approval_levels, config.approval_levels);
      if (config.notification_rules !== undefined) writeKv(db, KEYS.notification_rules, config.notification_rules);
      if (config.escalation_matrix !== undefined) writeKv(db, KEYS.escalation_matrix, config.escalation_matrix);
      if (config.working_hours !== undefined) writeKv(db, KEYS.working_hours, config.working_hours);
      if (config.holidays !== undefined) writeKv(db, KEYS.holidays, config.holidays);
      if (config.reminder_interval_hours !== undefined) {
        const n = Math.max(1, Math.min(720, Number(config.reminder_interval_hours) || DEFAULTS.reminder_interval_hours));
        writeKv(db, KEYS.reminder_interval_hours, n);
      }
    }
    if (body?.priorities !== undefined) writeKv(db, KEYS.priorities, body.priorities);

    // Echo back the fresh state.
    return GET();
  } catch (e: any) {
    console.error('PUT /api/tasks/settings failed:', e);
    return Response.json({ error: e?.message || 'Failed to save settings' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const g = await requireAdmin();
  if ('resp' in g) return g.resp;

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const name = String(body?.name || '').trim();
  if (!name) return Response.json({ error: 'Category name is required' }, { status: 400 });

  try {
    const db = getDb();
    const dupe = db.prepare(`SELECT id FROM task_categories WHERE name = ? COLLATE NOCASE`).get(name) as any;
    if (dupe) return Response.json({ error: 'A category with that name already exists' }, { status: 409 });

    const maxRow = db.prepare(`SELECT MAX(sort_order) m FROM task_categories`).get() as any;
    const sortOrder = (maxRow?.m ?? -1) + 1;
    const id = generateId();
    db.prepare(`INSERT INTO task_categories (id, name, color, icon, sort_order) VALUES (?, ?, ?, ?, ?)`).run(
      id,
      name,
      String(body?.color || '').trim(),
      String(body?.icon || '').trim(),
      sortOrder,
    );
    const category = db.prepare(`SELECT * FROM task_categories WHERE id = ?`).get(id);
    return Response.json({ category });
  } catch (e: any) {
    console.error('POST /api/tasks/settings failed:', e);
    return Response.json({ error: e?.message || 'Failed to create category' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const g = await requireAdmin();
  if ('resp' in g) return g.resp;

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const id = String(body?.id || '').trim();
  if (!id) return Response.json({ error: 'Category id is required' }, { status: 400 });

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM task_categories WHERE id = ?`).get(id) as any;
    if (!existing) return Response.json({ error: 'Category not found' }, { status: 404 });

    const sets: string[] = [];
    const args: any[] = [];
    if (body.name !== undefined) {
      const name = String(body.name || '').trim();
      if (!name) return Response.json({ error: 'Category name cannot be empty' }, { status: 400 });
      const dupe = db.prepare(`SELECT id FROM task_categories WHERE name = ? COLLATE NOCASE AND id != ?`).get(name, id) as any;
      if (dupe) return Response.json({ error: 'A category with that name already exists' }, { status: 409 });
      sets.push('name = ?'); args.push(name);
    }
    if (body.color !== undefined) { sets.push('color = ?'); args.push(String(body.color || '').trim()); }
    if (body.icon !== undefined) { sets.push('icon = ?'); args.push(String(body.icon || '').trim()); }
    if (body.sort_order !== undefined) { sets.push('sort_order = ?'); args.push(Number(body.sort_order) || 0); }
    if (body.is_active !== undefined) { sets.push('is_active = ?'); args.push(body.is_active ? 1 : 0); }
    if (!sets.length) return Response.json({ error: 'Nothing to update' }, { status: 400 });

    sets.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE task_categories SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    const category = db.prepare(`SELECT * FROM task_categories WHERE id = ?`).get(id);
    return Response.json({ category });
  } catch (e: any) {
    console.error('PATCH /api/tasks/settings failed:', e);
    return Response.json({ error: e?.message || 'Failed to update category' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const g = await requireAdmin();
  if ('resp' in g) return g.resp;

  const url = new URL(request.url);
  const id = String(url.searchParams.get('id') || '').trim();
  if (!id) return Response.json({ error: 'Category id is required' }, { status: 400 });

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT id FROM task_categories WHERE id = ?`).get(id) as any;
    if (!existing) return Response.json({ error: 'Category not found' }, { status: 404 });
    db.prepare(`UPDATE task_categories SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
    return Response.json({ ok: true });
  } catch (e: any) {
    console.error('DELETE /api/tasks/settings failed:', e);
    return Response.json({ error: e?.message || 'Failed to deactivate category' }, { status: 500 });
  }
}
