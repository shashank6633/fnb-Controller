/**
 * Task Management — automation engine (Phase 2).
 *
 * The unattended, once-per-day side of the Task module. Everything a human
 * would otherwise click ("Generate due tasks now", chase overdue work) runs
 * here, driven by the /api/cron/refresh-parties pipeline (external cron or an
 * admin manual run).
 *
 * Design rules (mirrors src/lib/whatsapp.ts runWaDailyNotifications):
 *   - Every public fn is BEST-EFFORT: it swallows its own errors and never
 *     throws into the cron request. A returned status string is the only signal.
 *   - Idempotent per calendar day (IST). Re-running the same day is a no-op:
 *     generation guards on last_run_date / last_generated_date == today; the
 *     overdue sweep dedupes on an existing same-day notification; the
 *     orchestrator additionally short-circuits on a settings sentinel.
 *   - ADDITIVE only. No schema changes — new config lives in the settings KV
 *     table under tm_* keys, read with a default (written only on admin save).
 *
 * Dates are IST calendar-day strings (todayIST) to match how due dates are
 * entered and displayed across the module.
 */

import { getDb, generateId } from '@/lib/db';
import { todayIST } from '@/lib/format-date';
import {
  nextRecurrence,
  type RecurrenceFrequency,
} from '@/lib/tasks';
import { sendPushToUser } from '@/lib/push';

type Db = ReturnType<typeof getDb>;

/**
 * Fire a best-effort web-push mirroring a just-inserted task_notification.
 *
 * Deferred to a microtask so it runs AFTER any surrounding better-sqlite3
 * transaction has committed — the synchronous prefix of sendPushToUser (its
 * settings/subscription reads) never executes inside the caller's transaction,
 * and the send never blocks the response. sendPushToUser itself never throws;
 * the try/catch + .catch() here are belt-and-braces so a push failure can never
 * surface to — or break — the notification insert.
 */
function firePush(
  db: Db,
  email: string,
  payload: { title: string; body: string; url?: string },
): void {
  try {
    if (!email) return;
    Promise.resolve()
      .then(() => sendPushToUser(db, email, payload))
      .catch(() => {
        /* never */
      });
  } catch {
    /* never throw */
  }
}

const FREQS: readonly RecurrenceFrequency[] = ['daily', 'weekly', 'monthly'];

/** Statuses that mean "no longer actionable" — excluded from the overdue sweep. */
const TERMINAL_STATUSES = ['completed', 'approved', 'cancelled'];

/* ------------------------------------------------------------------ *
 * settings helpers (best-effort KV reads/writes)
 * ------------------------------------------------------------------ */

function getSetting(db: Db, key: string, fallback = ''): string {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

function setSetting(db: Db, key: string, value: string): void {
  try {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, String(value ?? ''));
  } catch {
    /* never throw */
  }
}

/* ------------------------------------------------------------------ *
 * small date/time helpers (IST)
 * ------------------------------------------------------------------ */

/** Current wall-clock time in IST as "HH:MM" (24h). */
function nowHHMMIST(): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
  } catch {
    return '23:59';
  }
}

/** Whole days between two YYYY-MM-DD strings (b - a). 0 / negative if not before. */
function daysBetween(aISO: string, bISO: string): number {
  const a = Date.parse(`${aISO}T00:00:00Z`);
  const b = Date.parse(`${bISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

/** Normalise a stored due_time ("14:00" / "14:00:00" / "") to "HH:MM" or ''. */
function hhmm(t: string | null | undefined): string {
  if (!t) return '';
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t).trim());
  if (!m) return '';
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function safeFreq(f: string | null | undefined): RecurrenceFrequency {
  return FREQS.includes(f as RecurrenceFrequency) ? (f as RecurrenceFrequency) : 'daily';
}

/* ------------------------------------------------------------------ *
 * notifications
 * ------------------------------------------------------------------ */

/**
 * INSERT a `kind='assigned'` notification for an assignee. Used by the tasks API
 * on create/assign and by the recurring/maintenance generators. Best-effort —
 * never throws. No-ops when the assignee email is blank.
 */
export function notifyTaskAssignment(
  db: Db,
  taskId: string,
  assigneeEmail: string,
  byName: string,
): void {
  try {
    const email = String(assigneeEmail || '').trim();
    if (!email) return;
    const task = db.prepare('SELECT title FROM tasks WHERE id = ?').get(taskId) as
      | { title?: string }
      | undefined;
    const title = task?.title || 'Task';
    const who = String(byName || '').trim() || 'The system';
    db.prepare(
      `INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href)
       VALUES (?, ?, 'assigned', ?, ?, ?, ?)`,
    // href points at an existing page route. There is no /tasks/[id] detail
    // route, so linking to /tasks/${taskId} would 404 — the assignee's task
    // list (/tasks/my) is the valid Phase-1 destination.
    ).run(generateId(), email, `New task: ${title}`, `${who} assigned you a task.`, taskId, `/tasks/my`);
    // Best-effort push mirror (same title/body/href as the in-app row).
    firePush(db, email, { title: `New task: ${title}`, body: `${who} assigned you a task.`, url: '/tasks/my' });
  } catch {
    /* never throw */
  }
}

/** Has recipient already got a notification of this kind for this task today? */
function hasNotifToday(db: Db, recipient: string, kind: string, taskId: string): boolean {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM task_notifications
         WHERE recipient_email = ? AND kind = ? AND task_id = ?
           AND date(created_at) = date('now')`,
      )
      .get(recipient, kind, taskId) as { n: number } | undefined;
    return (row?.n || 0) > 0;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 1. recurring task generation
 * ------------------------------------------------------------------ */

/**
 * For every active recurring_task_rules row due today (next_run_date set and
 * <= today), create a `source='recurring'` task, notify the assignee, then
 * advance next_run_date via nextRecurrence() and stamp last_run_date=today.
 *
 * Idempotent: a rule already run today (last_run_date == today) is skipped, so a
 * second invocation the same day generates nothing. Best-effort — never throws.
 */
export function generateRecurringTasks(db: Db): { generated: number; skipped: number; error?: string } {
  const today = todayIST();
  let generated = 0;
  let skipped = 0;
  try {
    // A blank next_run_date sorts before any date ('' <= today), so it is treated
    // as "due now" — i.e. first-run catch-up, mirroring the manual maintenance path.
    const due = db
      .prepare(
        `SELECT * FROM recurring_task_rules
         WHERE is_active = 1 AND next_run_date <= ?`,
      )
      .all(today) as any[];

    const tx = db.transaction(() => {
      for (const r of due) {
        // Idempotency guard — never double-generate for the same day.
        if (r.last_run_date === today) {
          skipped++;
          continue;
        }
        const taskId = generateId();
        const freq = safeFreq(r.frequency);
        const status = r.assignee_email ? 'assigned' : 'draft';
        const title = String(r.title || 'Recurring task');

        db.prepare(
          `INSERT INTO tasks
             (id, title, description, category, department, priority, status,
              assignee_email, created_by, due_date, source, recurring_rule_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recurring', ?)`,
        ).run(
          taskId,
          title,
          String(r.description || ''),
          String(r.category || 'Operations') || 'Operations',
          String(r.department || ''),
          String(r.priority || 'medium') || 'medium',
          status,
          String(r.assignee_email || ''),
          'system_automation',
          today,
          r.id,
        );

        db.prepare(
          `INSERT INTO task_status_history (id, task_id, from_status, to_status, changed_by, note)
           VALUES (?, ?, '', ?, 'system_automation', ?)`,
        ).run(generateId(), taskId, status, `Auto-generated from recurring rule`);

        if (r.assignee_email) notifyTaskAssignment(db, taskId, r.assignee_email, 'Recurring schedule');

        // Advance the cadence from TODAY (strictly-after), so a rule whose
        // next_run_date drifted into the past can never get stuck regenerating.
        const dow = Number.isFinite(+r.day_of_week) ? Math.trunc(+r.day_of_week) : undefined;
        const dom = Number.isFinite(+r.day_of_month) ? Math.trunc(+r.day_of_month) : undefined;
        const next = nextRecurrence(freq, today, dow, dom) || today;
        db.prepare(
          `UPDATE recurring_task_rules
           SET next_run_date = ?, last_run_date = ?, updated_at = datetime('now')
           WHERE id = ?`,
        ).run(next, today, r.id);

        generated++;
      }
    });
    tx();
    return { generated, skipped };
  } catch (e: any) {
    try {
      console.error('[task-automation generateRecurringTasks]', e?.message || e);
    } catch {
      /* never */
    }
    return { generated, skipped, error: e?.message || 'error' };
  }
}

/* ------------------------------------------------------------------ *
 * 2. maintenance task generation
 * ------------------------------------------------------------------ */

/**
 * The automatic counterpart of the manual "Generate due tasks now" button:
 * for every active maintenance_schedules row due today, create a
 * `source='maintenance'` task, write a maintenance_logs 'generated' row, notify
 * the assignee, and advance next_due_date via nextRecurrence(frequency).
 *
 * Idempotent: a schedule already generated today (last_generated_date == today)
 * is skipped. Best-effort — never throws.
 */
export function generateMaintenanceTasks(db: Db): { generated: number; skipped: number; error?: string } {
  const today = todayIST();
  let generated = 0;
  let skipped = 0;
  try {
    // A blank next_due_date sorts before any date ('' <= today) → treated as
    // "due now" (first-run), matching the manual "Generate due tasks now" button.
    const due = db
      .prepare(
        `SELECT * FROM maintenance_schedules
         WHERE is_active = 1 AND next_due_date <= ?`,
      )
      .all(today) as any[];

    const tx = db.transaction(() => {
      for (const s of due) {
        // Idempotency guard — never double-generate for the same day.
        if (s.last_generated_date === today) {
          skipped++;
          continue;
        }
        const taskId = generateId();
        const freq = safeFreq(s.frequency);
        const status = s.assignee_email ? 'assigned' : 'draft';
        const title = `${s.name} — ${freq} maintenance`;
        const description = `Auto-generated from maintenance schedule "${s.name}" (${freq}).`;

        db.prepare(
          `INSERT INTO tasks
             (id, title, description, category, department, priority, status,
              assignee_email, created_by, due_date, source, recurring_rule_id)
           VALUES (?, ?, ?, ?, ?, 'medium', ?, ?, 'system_automation', ?, 'maintenance', ?)`,
        ).run(
          taskId,
          title,
          description,
          String(s.category || 'Maintenance') || 'Maintenance',
          String(s.department || 'Maintenance') || 'Maintenance',
          status,
          String(s.assignee_email || ''),
          today,
          s.id,
        );

        db.prepare(
          `INSERT INTO task_status_history (id, task_id, from_status, to_status, changed_by, note)
           VALUES (?, ?, '', ?, 'system_automation', ?)`,
        ).run(generateId(), taskId, status, `Auto-generated from schedule ${s.name}`);

        db.prepare(
          `INSERT INTO maintenance_logs (id, schedule_id, task_id, performed_by, performed_at, status, notes)
           VALUES (?, ?, ?, 'system_automation', '', 'generated', ?)`,
        ).run(generateId(), s.id, taskId, `Task auto-generated for ${today}`);

        if (s.assignee_email) notifyTaskAssignment(db, taskId, s.assignee_email, 'Maintenance schedule');

        const next = nextRecurrence(freq, today) || today;
        db.prepare(
          `UPDATE maintenance_schedules
           SET next_due_date = ?, last_generated_date = ?, updated_at = datetime('now')
           WHERE id = ?`,
        ).run(next, today, s.id);

        generated++;
      }
    });
    tx();
    return { generated, skipped };
  } catch (e: any) {
    try {
      console.error('[task-automation generateMaintenanceTasks]', e?.message || e);
    } catch {
      /* never */
    }
    return { generated, skipped, error: e?.message || 'error' };
  }
}

/* ------------------------------------------------------------------ *
 * 3. overdue detection + escalation
 * ------------------------------------------------------------------ */

/**
 * Resolve escalation recipient emails from the settings-backed matrix.
 * tm_escalation_targets is a JSON array of user *roles* to copy in
 * (default ["manager","admin"] — the General Manager / Admin tail of the
 * Employee -> Reporting Manager -> GM -> Admin chain). Falls back to the
 * default on any parse error. Excludes the assignee themselves.
 */
function escalationRecipients(db: Db, excludeEmail: string): string[] {
  let roles: string[] = ['manager', 'admin'];
  try {
    const raw = getSetting(db, 'tm_escalation_targets', '');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        roles = parsed.map((r) => String(r).trim().toLowerCase()).filter(Boolean);
      }
    }
  } catch {
    /* keep default */
  }
  try {
    const placeholders = roles.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT DISTINCT email FROM users
         WHERE is_active = 1 AND lower(role) IN (${placeholders})`,
      )
      .all(...roles) as { email: string }[];
    const ex = excludeEmail.trim().toLowerCase();
    return rows
      .map((r) => r.email)
      .filter((e) => e && e.trim().toLowerCase() !== ex);
  } catch {
    return [];
  }
}

/**
 * Sweep every actionable task past its due date/time (status not terminal,
 * not archived) and:
 *   - notify the assignee once/day (kind='overdue', deduped on today's row).
 *   - once the overdue age reaches the configured threshold, also notify the
 *     escalation targets once/day (kind='escalation').
 *
 * Config (settings, all optional):
 *   tm_escalation_enabled        '1'|'0'   default '1'
 *   tm_escalation_threshold_days number    default 1  (escalate when overdue > 1 day)
 *   tm_escalation_targets        JSON[]    default ["manager","admin"]
 *
 * Best-effort — never throws.
 */
export function detectOverdueAndEscalate(
  db: Db,
): { overdue: number; assignee_notified: number; escalated: number; error?: string } {
  const today = todayIST();
  const nowT = nowHHMMIST();
  let overdue = 0;
  let assigneeNotified = 0;
  let escalated = 0;

  try {
    const escEnabled = getSetting(db, 'tm_escalation_enabled', '1') !== '0';
    const thresholdDays = (() => {
      const n = parseInt(getSetting(db, 'tm_escalation_threshold_days', '1'), 10);
      return Number.isFinite(n) && n >= 0 ? n : 1;
    })();

    const placeholders = TERMINAL_STATUSES.map(() => '?').join(',');
    const candidates = db
      .prepare(
        `SELECT id, title, assignee_email, due_date, due_time
         FROM tasks
         WHERE is_archived = 0
           AND due_date != ''
           AND due_date <= ?
           AND status NOT IN (${placeholders})`,
      )
      .all(today, ...TERMINAL_STATUSES) as any[];

    for (const t of candidates) {
      const dueDate = String(t.due_date || '');
      const dueTime = hhmm(t.due_time);

      // Due TODAY is overdue only once a set due_time has passed. With no due_time
      // the task has all day, so it is not overdue on its own due date — this also
      // stops tasks just generated this same cron pass (due_date=today) from being
      // flagged overdue immediately. Tasks with due_date < today are always overdue.
      if (dueDate === today && (!dueTime || dueTime >= nowT)) continue;

      overdue++;
      const assignee = String(t.assignee_email || '').trim();
      const overdueDays = daysBetween(dueDate, today); // 0 = due today (time passed)

      // 3a. Notify the assignee once/day.
      if (assignee && !hasNotifToday(db, assignee, 'overdue', t.id)) {
        try {
          const ageTxt = overdueDays <= 0 ? 'today' : `${overdueDays} day${overdueDays === 1 ? '' : 's'} ago`;
          db.prepare(
            `INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href)
             VALUES (?, ?, 'overdue', ?, ?, ?, ?)`,
          ).run(
            generateId(),
            assignee,
            `Overdue: ${t.title || 'Task'}`,
            `This task was due ${ageTxt} and is still open.`,
            t.id,
            // No /tasks/[id] detail route exists — link the assignee to their
            // own task list rather than a 404.
            `/tasks/my`,
          );
          firePush(db, assignee, {
            title: `Overdue: ${t.title || 'Task'}`,
            body: `This task was due ${ageTxt} and is still open.`,
            url: '/tasks/my',
          });
          assigneeNotified++;
        } catch {
          /* never */
        }
      }

      // 3b. Escalate once/day when overdue age reaches the threshold.
      if (escEnabled && overdueDays >= thresholdDays) {
        const targets = escalationRecipients(db, assignee);
        for (const rcpt of targets) {
          if (hasNotifToday(db, rcpt, 'escalation', t.id)) continue;
          try {
            const escTitle = `Escalation: ${t.title || 'Task'} overdue`;
            const escBody = `A task assigned to ${assignee || 'an unassigned owner'} is ${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue.`;
            db.prepare(
              `INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href)
               VALUES (?, ?, 'escalation', ?, ?, ?, ?)`,
            ).run(
              generateId(),
              rcpt,
              escTitle,
              escBody,
              t.id,
              // Escalation recipients are managers/admins; the board shows all
              // tasks (not just their own), so it is the right landing page.
              // There is no /tasks/[id] detail route to link directly.
              `/tasks/board`,
            );
            firePush(db, rcpt, { title: escTitle, body: escBody, url: '/tasks/board' });
            escalated++;
          } catch {
            /* never */
          }
        }
      }
    }

    return { overdue, assignee_notified: assigneeNotified, escalated };
  } catch (e: any) {
    try {
      console.error('[task-automation detectOverdueAndEscalate]', e?.message || e);
    } catch {
      /* never */
    }
    return { overdue, assignee_notified: assigneeNotified, escalated, error: e?.message || 'error' };
  }
}

/* ------------------------------------------------------------------ *
 * orchestrator
 * ------------------------------------------------------------------ */

export interface TaskAutomationResult {
  ran: boolean;
  date: string;
  /** Present when the day's run was already done (sentinel short-circuit). */
  skipped?: string;
  recurring?: ReturnType<typeof generateRecurringTasks>;
  maintenance?: ReturnType<typeof generateMaintenanceTasks>;
  overdue?: ReturnType<typeof detectOverdueAndEscalate>;
}

/**
 * Orchestrate the three jobs, once per calendar day (IST). A settings sentinel
 * (tm_automation_last_run=YYYY-MM-DD) short-circuits a repeat run the same day;
 * each job additionally carries its own idempotency guard as a backstop. The
 * sentinel is stamped only after all three complete, so a mid-run failure lets
 * the next invocation retry. NEVER throws — returns a per-job status map.
 */
export function runTaskAutomation(db: Db): TaskAutomationResult {
  const today = todayIST();
  try {
    if (getSetting(db, 'tm_automation_last_run', '') === today) {
      return { ran: false, date: today, skipped: 'already_ran_today' };
    }

    const recurring = generateRecurringTasks(db);
    const maintenance = generateMaintenanceTasks(db);
    const overdue = detectOverdueAndEscalate(db);

    setSetting(db, 'tm_automation_last_run', today);

    return { ran: true, date: today, recurring, maintenance, overdue };
  } catch (e: any) {
    try {
      console.error('[task-automation runTaskAutomation]', e?.message || e);
    } catch {
      /* never */
    }
    return { ran: false, date: today, skipped: `error: ${e?.message || 'unknown'}` };
  }
}
