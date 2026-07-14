/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import {
  canManageTasks,
  nextRecurrence,
  TASK_CATEGORIES,
  TASK_DEPARTMENTS,
  TASK_PRIORITIES,
  type RecurrenceFrequency,
} from '@/lib/tasks';
import { todayIST } from '@/lib/format-date';

/**
 * Recurring Task Rules API (Task Management — Phase 2).
 *
 * CRUD over the `recurring_task_rules` table that the automation engine
 * (src/lib/task-automation.ts → generateRecurringTasks) consumes once a day to
 * spawn source='recurring' tasks. This route only *manages* the rules; it never
 * generates tasks itself (that is the cron/automation path).
 *
 * GET    /api/tasks/recurring                        → { rules[], automation, meta }
 *          ?q=  ?frequency=daily|weekly|monthly  ?include_inactive=1
 *          Any signed-in user may READ (settings + maintenance pages render it).
 * POST   /api/tasks/recurring   { title, ...fields } → create a rule.       canManageTasks
 * PUT    /api/tasks/recurring   { id, ...fields }    → update a rule.        canManageTasks
 * DELETE /api/tasks/recurring?id=  [&hard=1]         → deactivate (default) or
 *          permanently remove a rule.                                        canManageTasks
 *
 * Config-shaped writes go nowhere near the existing tasks/settings tables — this
 * is purely additive over recurring_task_rules. next_run_date is normalised via
 * nextRecurrence() so the automation engine always has a valid cadence anchor.
 */
export const dynamic = 'force-dynamic';

const FREQS: RecurrenceFrequency[] = ['daily', 'weekly', 'monthly'];

function safeFreq(f: any): RecurrenceFrequency {
  return FREQS.includes(f) ? f : 'daily';
}

function clampInt(v: any, min: number, max: number, dflt: number): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

/** Valid YYYY-MM-DD or ''. */
function normDate(v: any): string {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/**
 * Resolve the next_run_date for a rule. If the admin supplied a valid date use it
 * verbatim (they may intentionally back-date it to "fire on next run"); otherwise
 * compute the next occurrence strictly after today from the cadence settings.
 */
function resolveNextRun(
  explicit: any,
  freq: RecurrenceFrequency,
  dow: number,
  dom: number,
): string {
  const given = normDate(explicit);
  if (given) return given;
  const today = todayIST();
  return nextRecurrence(freq, today, freq === 'weekly' ? dow : undefined, freq === 'monthly' ? dom : undefined) || today;
}

/** Attach a human-friendly "following run" preview to a rule row. */
function withPreview(r: any) {
  const freq = safeFreq(r.frequency);
  const dow = clampInt(r.day_of_week, 0, 6, 0);
  const dom = clampInt(r.day_of_month, 1, 31, 1);
  const anchor = normDate(r.next_run_date) || todayIST();
  const following = nextRecurrence(
    freq,
    anchor,
    freq === 'weekly' ? dow : undefined,
    freq === 'monthly' ? dom : undefined,
  );
  return { ...r, next_run_preview: following };
}

// ---------- GET ----------
export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Not signed in' }, { status: 401 });

    const db = getDb();
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const freq = url.searchParams.get('frequency') || '';
    const includeInactive = url.searchParams.get('include_inactive') === '1';

    const where: string[] = [];
    const params: any[] = [];
    if (!includeInactive) where.push('is_active = 1');
    if (freq && FREQS.includes(freq as RecurrenceFrequency)) {
      where.push('frequency = ?');
      params.push(freq);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let rules = db
      .prepare(
        `SELECT * FROM recurring_task_rules ${whereSql}
         ORDER BY is_active DESC,
                  CASE frequency WHEN 'daily' THEN 0 WHEN 'weekly' THEN 1 WHEN 'monthly' THEN 2 ELSE 3 END,
                  title COLLATE NOCASE ASC`,
      )
      .all(...params) as any[];

    if (q) {
      rules = rules.filter(
        (r) =>
          String(r.title || '').toLowerCase().includes(q) ||
          String(r.department || '').toLowerCase().includes(q) ||
          String(r.category || '').toLowerCase().includes(q),
      );
    }

    const today = todayIST();
    const rulesOut = rules.map(withPreview);
    const dueCount = rulesOut.filter((r) => r.is_active && (!r.next_run_date || r.next_run_date <= today)).length;

    // Automation status (read-only mirror of the settings sentinel written by the
    // task-automation orchestrator — never mutated here).
    const lastRunRow = db.prepare(`SELECT value FROM settings WHERE key = 'tm_automation_last_run'`).get() as
      | { value?: string }
      | undefined;
    const last_run = lastRunRow?.value || '';

    return Response.json({
      rules: rulesOut,
      automation: {
        last_run,
        today,
        ran_today: last_run === today,
        due_count: dueCount,
      },
      meta: {
        categories: TASK_CATEGORIES,
        departments: TASK_DEPARTMENTS,
        priorities: TASK_PRIORITIES.map((p) => ({ key: p.key, label: p.label })),
      },
      can_manage: canManageTasks(me),
    });
  } catch (error: any) {
    console.error('GET /api/tasks/recurring failed:', error);
    return Response.json({ error: error?.message || 'Failed to load' }, { status: 500 });
  }
}

// ---------- POST (create rule) ----------
export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Not signed in' }, { status: 401 });
    if (!canManageTasks(me))
      return Response.json({ error: 'Not authorized to manage recurring rules' }, { status: 403 });

    const db = getDb();
    const body = await request.json().catch(() => ({}));

    const title = String(body?.title || '').trim();
    if (!title) return Response.json({ error: 'title is required' }, { status: 400 });

    const frequency = safeFreq(body?.frequency);
    const day_of_week = clampInt(body?.day_of_week, 0, 6, 0);
    const day_of_month = clampInt(body?.day_of_month, 1, 31, 1);
    const next_run_date = resolveNextRun(body?.next_run_date, frequency, day_of_week, day_of_month);
    const is_active = body?.is_active === 0 || body?.is_active === false ? 0 : 1;
    const actor = me.email || me.name || 'system';

    const id = generateId();
    db.prepare(
      `INSERT INTO recurring_task_rules
         (id, title, description, category, department, assignee_email, priority,
          frequency, day_of_week, day_of_month, next_run_date, is_active, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      title,
      String(body?.description || '').trim(),
      String(body?.category || 'Operations').trim() || 'Operations',
      String(body?.department || '').trim(),
      String(body?.assignee_email || '').trim(),
      String(body?.priority || 'medium').trim() || 'medium',
      frequency,
      day_of_week,
      day_of_month,
      next_run_date,
      is_active,
      actor,
    );

    const rule = db.prepare(`SELECT * FROM recurring_task_rules WHERE id = ?`).get(id);
    return Response.json({ rule: withPreview(rule) }, { status: 201 });
  } catch (error: any) {
    console.error('POST /api/tasks/recurring failed:', error);
    return Response.json({ error: error?.message || 'Failed to create rule' }, { status: 500 });
  }
}

// ---------- PUT (update rule) ----------
export async function PUT(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Not signed in' }, { status: 401 });
    if (!canManageTasks(me))
      return Response.json({ error: 'Not authorized to manage recurring rules' }, { status: 403 });

    const db = getDb();
    const body = await request.json().catch(() => ({}));
    const id = String(body?.id || '').trim();
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

    const existing = db.prepare(`SELECT * FROM recurring_task_rules WHERE id = ?`).get(id) as any;
    if (!existing) return Response.json({ error: 'Rule not found' }, { status: 404 });

    const sets: string[] = [];
    const params: any[] = [];
    const setField = (col: string, val: any) => {
      sets.push(`${col} = ?`);
      params.push(val);
    };

    if (typeof body.title === 'string' && body.title.trim()) setField('title', body.title.trim());
    if (typeof body.description === 'string') setField('description', body.description.trim());
    if (typeof body.category === 'string') setField('category', body.category.trim() || 'Operations');
    if (typeof body.department === 'string') setField('department', body.department.trim());
    if (typeof body.assignee_email === 'string') setField('assignee_email', body.assignee_email.trim());
    if (typeof body.priority === 'string' && body.priority.trim()) setField('priority', body.priority.trim());

    // Cadence — recompute next_run_date whenever cadence inputs change (unless an
    // explicit next_run_date is supplied).
    const nextFreq = body.frequency !== undefined ? safeFreq(body.frequency) : safeFreq(existing.frequency);
    const nextDow = body.day_of_week !== undefined ? clampInt(body.day_of_week, 0, 6, 0) : clampInt(existing.day_of_week, 0, 6, 0);
    const nextDom = body.day_of_month !== undefined ? clampInt(body.day_of_month, 1, 31, 1) : clampInt(existing.day_of_month, 1, 31, 1);

    if (body.frequency !== undefined) setField('frequency', nextFreq);
    if (body.day_of_week !== undefined) setField('day_of_week', nextDow);
    if (body.day_of_month !== undefined) setField('day_of_month', nextDom);

    const explicitDate = normDate(body.next_run_date);
    if (explicitDate) {
      setField('next_run_date', explicitDate);
    } else if (body.frequency !== undefined || body.day_of_week !== undefined || body.day_of_month !== undefined) {
      // Cadence changed without an explicit date → recompute from today forward.
      setField('next_run_date', resolveNextRun('', nextFreq, nextDow, nextDom));
    }

    if (body.is_active === 0 || body.is_active === 1 || body.is_active === true || body.is_active === false)
      setField('is_active', body.is_active ? 1 : 0);

    if (!sets.length) return Response.json({ error: 'No fields to update' }, { status: 400 });

    sets.push(`updated_at = datetime('now')`);
    params.push(id);
    db.prepare(`UPDATE recurring_task_rules SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    const rule = db.prepare(`SELECT * FROM recurring_task_rules WHERE id = ?`).get(id);
    return Response.json({ rule: withPreview(rule) });
  } catch (error: any) {
    console.error('PUT /api/tasks/recurring failed:', error);
    return Response.json({ error: error?.message || 'Failed to update rule' }, { status: 500 });
  }
}

// ---------- DELETE (deactivate, or hard-delete) ----------
export async function DELETE(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Not signed in' }, { status: 401 });
    if (!canManageTasks(me))
      return Response.json({ error: 'Not authorized to manage recurring rules' }, { status: 403 });

    const db = getDb();
    const url = new URL(request.url);
    const id = String(url.searchParams.get('id') || '').trim();
    const hard = url.searchParams.get('hard') === '1';
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

    const existing = db.prepare(`SELECT id FROM recurring_task_rules WHERE id = ?`).get(id) as any;
    if (!existing) return Response.json({ error: 'Rule not found' }, { status: 404 });

    if (hard) {
      db.prepare(`DELETE FROM recurring_task_rules WHERE id = ?`).run(id);
      return Response.json({ ok: true, deleted: true });
    }
    db.prepare(`UPDATE recurring_task_rules SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
    return Response.json({ ok: true, deactivated: true });
  } catch (error: any) {
    console.error('DELETE /api/tasks/recurring failed:', error);
    return Response.json({ error: error?.message || 'Failed to delete rule' }, { status: 500 });
  }
}
