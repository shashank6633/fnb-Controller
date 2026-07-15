import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import {
  canManageTasks,
  nextRecurrence,
  parseMentions,
  TASK_DEPARTMENTS,
  type RecurrenceFrequency,
  type MaintenanceSchedule,
} from '@/lib/tasks';
import { sendPushToUser } from '@/lib/push';

/**
 * Best-effort web-push mirroring a just-inserted task_notification. Deferred to
 * a microtask so it runs after the surrounding better-sqlite3 transaction
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
 * Maintenance schedules + logs API (Task Management slice).
 *
 * GET    /api/tasks/maintenance                      → { schedules[], logs[] }
 *          ?q=  ?frequency=daily|weekly|monthly  ?active=1|0  ?schedule_id=<id> (logs filter)
 * POST   /api/tasks/maintenance   { action, ... }
 *          action:'create'         → new schedule
 *          action:'generate'       → for every active schedule due (next_due_date<=today,
 *                                    or blank) create a source=maintenance task, write a
 *                                    maintenance_logs row, advance next_due_date via
 *                                    nextRecurrence; returns { generated, tasks[] }.
 *          action:'log-complete'   → mark a due/generated maintenance task done: write a
 *                                    maintenance_logs row + advance the schedule.
 * PUT    /api/tasks/maintenance   { id, ...fields } → update a schedule
 *
 * All mutations gate on canManageTasks. Automatic generation is triggered here by the
 * "Generate due tasks now" button; a later phase wires the same 'generate' action to cron.
 */

const FREQS: RecurrenceFrequency[] = ['daily', 'weekly', 'monthly'];

function todayISO(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

/** Write a status-history row (best-effort — never throws into the request). */
function writeHistory(
  db: ReturnType<typeof getDb>,
  taskId: string,
  from: string,
  to: string,
  by: string,
  note = '',
) {
  try {
    db.prepare(
      `INSERT INTO task_status_history (id, task_id, from_status, to_status, changed_by, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(generateId(), taskId, from, to, by, note);
  } catch (e) {
    console.error('task_status_history write failed:', e);
  }
}

/** Parse @mentions in free text → task_mentions rows + notifications. */
function recordMentions(
  db: ReturnType<typeof getDb>,
  taskId: string,
  text: string,
  by: string,
  title: string,
  href: string,
) {
  const tokens = parseMentions(text);
  if (!tokens.length) return;
  const insMention = db.prepare(
    `INSERT INTO task_mentions (id, task_id, comment_id, mentioned_email, mentioned_name, mentioned_by)
     VALUES (?, ?, '', ?, ?, ?)`,
  );
  const insNotif = db.prepare(
    `INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href)
     VALUES (?, ?, 'mention', ?, ?, ?, ?)`,
  );
  for (const tok of tokens) {
    const isEmail = tok.includes('@');
    insMention.run(generateId(), taskId, isEmail ? tok : '', isEmail ? '' : tok, by);
    if (isEmail) {
      insNotif.run(generateId(), tok, title, `You were mentioned by ${by}`, taskId, href);
    }
  }
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
    const active = url.searchParams.get('active');
    const scheduleId = url.searchParams.get('schedule_id') || '';

    const where: string[] = [];
    const params: any[] = [];
    if (freq && FREQS.includes(freq as RecurrenceFrequency)) {
      where.push('frequency = ?');
      params.push(freq);
    }
    if (active === '0' || active === '1') {
      where.push('is_active = ?');
      params.push(Number(active));
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let schedules = db
      .prepare(
        `SELECT * FROM maintenance_schedules ${whereSql}
         ORDER BY CASE frequency WHEN 'daily' THEN 0 WHEN 'weekly' THEN 1 WHEN 'monthly' THEN 2 ELSE 3 END,
                  name COLLATE NOCASE ASC`,
      )
      .all(...params) as MaintenanceSchedule[];

    if (q) {
      schedules = schedules.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.department || '').toLowerCase().includes(q) ||
          (s.category || '').toLowerCase().includes(q),
      );
    }

    const today = todayISO();
    const withDue = schedules.map((s) => ({
      ...s,
      is_due: !!s.is_active && (!s.next_due_date || s.next_due_date <= today),
    }));

    // Recent logs (optionally scoped to a schedule), joined with schedule name.
    const logParams: any[] = [];
    let logWhere = '';
    if (scheduleId) {
      logWhere = 'WHERE l.schedule_id = ?';
      logParams.push(scheduleId);
    }
    const logs = db
      .prepare(
        `SELECT l.*, s.name AS schedule_name, s.frequency AS schedule_frequency
         FROM maintenance_logs l
         LEFT JOIN maintenance_schedules s ON s.id = l.schedule_id
         ${logWhere}
         ORDER BY l.created_at DESC
         LIMIT 200`,
      )
      .all(...logParams);

    return Response.json({
      schedules: withDue,
      logs,
      departments: TASK_DEPARTMENTS,
      today,
      can_manage: canManageTasks(me),
    });
  } catch (error: any) {
    console.error('GET /api/tasks/maintenance failed:', error);
    return Response.json({ error: error?.message || 'Failed to load' }, { status: 500 });
  }
}

// ---------- POST ----------
export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Not signed in' }, { status: 401 });
    if (!canManageTasks(me))
      return Response.json({ error: 'Not authorized to manage maintenance' }, { status: 403 });

    const db = getDb();
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || 'create');
    const actor = me.email || me.name || 'system';

    // ── create schedule ──
    if (action === 'create') {
      const name = String(body?.name || '').trim();
      if (!name) return Response.json({ error: 'name is required' }, { status: 400 });
      const frequency = FREQS.includes(body?.frequency) ? body.frequency : 'daily';
      const category = String(body?.category || 'Maintenance').trim() || 'Maintenance';
      const department = String(body?.department || 'Maintenance').trim();
      const assignee_email = String(body?.assignee_email || '').trim();
      const next_due_date = String(body?.next_due_date || '').trim();
      const is_active = body?.is_active === 0 || body?.is_active === false ? 0 : 1;

      const id = generateId();
      db.prepare(
        `INSERT INTO maintenance_schedules
           (id, name, category, frequency, department, assignee_email, next_due_date, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, name, category, frequency, department, assignee_email, next_due_date, is_active);

      const schedule = db.prepare(`SELECT * FROM maintenance_schedules WHERE id = ?`).get(id);
      return Response.json({ schedule }, { status: 201 });
    }

    // ── generate due tasks ──
    if (action === 'generate') {
      const today = todayISO();
      const due = db
        .prepare(
          `SELECT * FROM maintenance_schedules
           WHERE is_active = 1 AND (next_due_date = '' OR next_due_date <= ?)`,
        )
        .all(today) as MaintenanceSchedule[];

      const created: any[] = [];
      const tx = db.transaction(() => {
        for (const s of due) {
          const taskId = generateId();
          const freq = FREQS.includes(s.frequency as RecurrenceFrequency)
            ? (s.frequency as RecurrenceFrequency)
            : 'daily';
          const dueDate = s.next_due_date && s.next_due_date <= today ? s.next_due_date : today;
          const title = `${s.name} — ${freq} maintenance`;
          const description = `Auto-generated from maintenance schedule "${s.name}" (${freq}).`;

          db.prepare(
            `INSERT INTO tasks
               (id, title, description, category, department, priority, status,
                assignee_email, created_by, due_date, source, recurring_rule_id)
             VALUES (?, ?, ?, ?, ?, 'medium', ?, ?, ?, ?, 'maintenance', ?)`,
          ).run(
            taskId,
            title,
            description,
            s.category || 'Maintenance',
            s.department || 'Maintenance',
            s.assignee_email ? 'assigned' : 'draft',
            s.assignee_email || '',
            actor,
            dueDate,
            s.id,
          );

          writeHistory(db, taskId, '', s.assignee_email ? 'assigned' : 'draft', actor, `Generated from schedule ${s.name}`);

          // maintenance_logs row records the generation event.
          db.prepare(
            `INSERT INTO maintenance_logs (id, schedule_id, task_id, performed_by, performed_at, status, notes)
             VALUES (?, ?, ?, ?, ?, 'generated', ?)`,
          ).run(generateId(), s.id, taskId, actor, '', `Task generated for ${dueDate}`);

          // Notify the assignee.
          if (s.assignee_email) {
            db.prepare(
              `INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href)
               VALUES (?, ?, 'assigned', ?, ?, ?, ?)`,
            ).run(generateId(), s.assignee_email, title, `Maintenance task assigned for ${dueDate}`, taskId, `/tasks/${taskId}`);
            firePush(db, s.assignee_email, { title, body: `Maintenance task assigned for ${dueDate}`, url: `/tasks/${taskId}` });
          }

          // Advance the schedule.
          const advanceFrom = dueDate;
          const next = nextRecurrence(freq, advanceFrom) || today;
          db.prepare(
            `UPDATE maintenance_schedules
             SET next_due_date = ?, last_generated_date = ?, updated_at = datetime('now')
             WHERE id = ?`,
          ).run(next, today, s.id);

          created.push({ task_id: taskId, schedule_id: s.id, name: s.name, due_date: dueDate, next_due_date: next });
        }
      });
      tx();

      return Response.json({ generated: created.length, tasks: created });
    }

    // ── log-complete: mark a maintenance task done + advance schedule ──
    if (action === 'log-complete') {
      const scheduleId = String(body?.schedule_id || '').trim();
      const taskId = String(body?.task_id || '').trim();
      const notes = String(body?.notes || '').trim();
      if (!scheduleId) return Response.json({ error: 'schedule_id is required' }, { status: 400 });

      const s = db.prepare(`SELECT * FROM maintenance_schedules WHERE id = ?`).get(scheduleId) as
        | MaintenanceSchedule
        | undefined;
      if (!s) return Response.json({ error: 'Schedule not found' }, { status: 404 });

      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO maintenance_logs (id, schedule_id, task_id, performed_by, performed_at, status, notes)
         VALUES (?, ?, ?, ?, ?, 'done', ?)`,
      ).run(generateId(), scheduleId, taskId, actor, now, notes);

      // If a linked task exists, mark it completed + history.
      if (taskId) {
        const task = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as
          | { status: string }
          | undefined;
        if (task) {
          db.prepare(
            `UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = datetime('now') WHERE id = ?`,
          ).run(now, taskId);
          writeHistory(db, taskId, task.status, 'completed', actor, 'Maintenance logged complete');
          if (notes) recordMentions(db, taskId, notes, actor, `Maintenance: ${s.name}`, `/tasks/${taskId}`);
        }
      }

      // Advance the schedule from today so the next cycle is scheduled forward.
      const today = todayISO();
      const freq = FREQS.includes(s.frequency as RecurrenceFrequency)
        ? (s.frequency as RecurrenceFrequency)
        : 'daily';
      const next = nextRecurrence(freq, today) || today;
      db.prepare(
        `UPDATE maintenance_schedules SET next_due_date = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(next, scheduleId);

      const schedule = db.prepare(`SELECT * FROM maintenance_schedules WHERE id = ?`).get(scheduleId);
      return Response.json({ ok: true, schedule });
    }

    return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error: any) {
    console.error('POST /api/tasks/maintenance failed:', error);
    return Response.json({ error: error?.message || 'Failed' }, { status: 500 });
  }
}

// ---------- PUT (update schedule) ----------
export async function PUT(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Not signed in' }, { status: 401 });
    if (!canManageTasks(me))
      return Response.json({ error: 'Not authorized to manage maintenance' }, { status: 403 });

    const db = getDb();
    const body = await request.json().catch(() => ({}));
    const id = String(body?.id || '').trim();
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

    const existing = db.prepare(`SELECT * FROM maintenance_schedules WHERE id = ?`).get(id) as
      | MaintenanceSchedule
      | undefined;
    if (!existing) return Response.json({ error: 'Schedule not found' }, { status: 404 });

    const sets: string[] = [];
    const params: any[] = [];
    const setField = (col: string, val: any) => {
      sets.push(`${col} = ?`);
      params.push(val);
    };

    if (typeof body.name === 'string' && body.name.trim()) setField('name', body.name.trim());
    if (FREQS.includes(body.frequency)) setField('frequency', body.frequency);
    if (typeof body.category === 'string') setField('category', body.category.trim() || 'Maintenance');
    if (typeof body.department === 'string') setField('department', body.department.trim());
    if (typeof body.assignee_email === 'string') setField('assignee_email', body.assignee_email.trim());
    if (typeof body.next_due_date === 'string') setField('next_due_date', body.next_due_date.trim());
    if (body.is_active === 0 || body.is_active === 1 || body.is_active === true || body.is_active === false)
      setField('is_active', body.is_active ? 1 : 0);

    if (!sets.length) return Response.json({ error: 'No fields to update' }, { status: 400 });

    sets.push(`updated_at = datetime('now')`);
    params.push(id);
    db.prepare(`UPDATE maintenance_schedules SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    const schedule = db.prepare(`SELECT * FROM maintenance_schedules WHERE id = ?`).get(id);
    return Response.json({ schedule });
  } catch (error: any) {
    console.error('PUT /api/tasks/maintenance failed:', error);
    return Response.json({ error: error?.message || 'Failed' }, { status: 500 });
  }
}
