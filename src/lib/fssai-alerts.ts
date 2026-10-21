/**
 * FSSAI Compliance — the three things the corrective-action spine was missing
 * (owner §14 "corrective actions", §21 "integrate the Task Manager and
 * Maintenance", §23 "configurable escalation rules").
 *
 * SERVER ONLY — this file imports the database. The spine itself
 * (/api/fssai/corrective-actions) is unchanged in what it MEANS: a corrective
 * action still cannot un-fail a check, and nothing here writes against
 * fssai_runs or fssai_responses. Grep this file: the only FSSAI tables it
 * writes are fssai_corrective_actions.created_task_id and fssai_audit_log.
 *
 * ── WHAT WAS ACTUALLY MISSING, MEASURED BEFORE A LINE WAS WRITTEN ───────────
 *   1. `fssai_corrective_actions.created_task_id` was written by NOTHING. The
 *      P1 schema comment and the screen both said the fix was meant to become a
 *      row in the Task Manager staff already use; raiseFssaiCorrectiveActions
 *      left the column '' on purpose rather than fabricate a task id. So a
 *      corrective action existed only on a food-safety screen most staff never
 *      open, and nothing appeared in anybody's task list.
 *   2. NOTHING CHASED A LATE ACTION. `/fssai/corrective-actions` computes
 *      "overdue" on read — a red badge for whoever happens to look. No
 *      reminder, no escalation, nobody told.
 *   3. The Task module's own escalation engine CANNOT be relied on to cover (2).
 *      `runTaskAutomation` (src/lib/task-automation.ts) does exactly the right
 *      thing — and RECON §7.6 measured that its ONLY caller is
 *      /api/cron/refresh-parties, which needs an external cron on the box.
 *      Consistent with the live data: all 21 tasks are source='maintenance',
 *      status='draft', and nothing has ever escalated. Leaning on it would be
 *      the project's own inert-guard pattern: a chase that reads correctly and
 *      never fires.
 *
 * ── WHERE THE RULES LIVE, AND WHY IT IS `settings` ──────────────────────────
 * RECON §2.5 says an escalation recipient belongs in an `fssai_` table behind a
 * gated route rather than in `settings`, for two good reasons: PUT
 * /api/settings does not audit, and `settings` has no updated_by/updated_at, so
 * a changed rule leaves no trace of who or when. Wave 1 did not create an
 * `fssai_escalation_rules` table and src/lib/db.ts is not this lane's to edit,
 * so the rules live under `fssai_esc_*` keys — which is also the Task module's
 * own idiom for the identical job (`tm_escalation_*`).
 *
 * BOTH OF RECON'S OBJECTIONS ARE ANSWERED RATHER THAN IGNORED:
 *   · these keys are NEVER written through PUT /api/settings — the only writer
 *     is writeFssaiEscalationRules below, called from one admin-gated route;
 *   · every change writes an fssai_audit_log row with the BEFORE and AFTER
 *     values and the actor, so §19's "original value, changed value, who" holds
 *     for a rule exactly as it does for a record.
 * If a later phase adds the table, readFssaiEscalationRules is the one place to
 * repoint, and every default below is what the code does today — so the move
 * cannot change behaviour.
 *
 * ── HOW A SEND IS MADE EXACTLY ONCE ─────────────────────────────────────────
 * There is no `escalated_at` column to claim (and this lane may not add one), so
 * the claim is the `notifications` table's UNIQUE (party_unique_id, kind,
 * channel) — `INSERT OR IGNORE` returns changes=0 when the day's note for that
 * action already exists. That is the kitchen-expiry watchdog's pattern verbatim
 * (src/lib/kitchen-expiry-check.ts), it is atomic in SQLite rather than a
 * read-then-write race, and it means this sweep can run from a screen, from a
 * button and from a scheduler tick at the same moment without double-nagging a
 * chef. The per-person rows in `task_notifications` are only written AFTER the
 * claim is won.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
import { sendPushToUser } from '@/lib/push';
import { TASK_DEPARTMENTS } from '@/lib/tasks';
import {
  fssaiToday, isISODate, daysBetweenISO, fssaiCaIsClosed, fssaiCaSeverityMeta,
  isFssaiCaSeverity,
} from '@/lib/fssai';
import { fssaiAuditBestEffort } from '@/lib/fssai-server';

type Db = Database.Database;

/* ══════════════════════════════════════════════════════════════════════════
 * 1. THE RULES (owner §23)
 * ════════════════════════════════════════════════════════════════════════ */

/** Who an escalation copies in. Resolved to real addresses at send time. */
export type FssaiEscalationTarget = 'owner' | 'hod' | 'manager' | 'admin' | 'recorder';

export const FSSAI_ESCALATION_TARGETS: readonly { key: FssaiEscalationTarget; label: string; note: string }[] = [
  { key: 'owner', label: 'The person it is assigned to', note: 'Whoever is named on the action.' },
  { key: 'hod', label: 'Heads of department', note: 'Everybody marked as a head of department.' },
  { key: 'manager', label: 'Managers', note: 'Everybody on the manager tier.' },
  { key: 'admin', label: 'Administrators', note: 'Everybody on the admin tier.' },
  {
    key: 'recorder', label: 'Whoever recorded the failed check', note:
      'The member of staff who found the problem. They cannot sign the fix off, but they can see it is still open.',
  },
] as const;

export function isFssaiEscalationTarget(v: unknown): v is FssaiEscalationTarget {
  return FSSAI_ESCALATION_TARGETS.some((t) => t.key === String(v || ''));
}

/**
 * THE LADDER, AND WHY THESE NUMBERS.
 *
 * PROVISIONAL DEFAULTS — the owner has not ruled on any of them (§7 has no
 * question for escalation because nothing escalated before this). Every one is
 * a NUMBER IN A SETTING, changeable on the screen, and `enabled: false` turns
 * the whole thing off in one tick without touching code. The shape is the Task
 * module's (remind the owner, then escalate on an age threshold, to a
 * role list) so the two engines cannot teach staff two different habits.
 *
 * `urgent_escalates_same_day` exists because the due date for an urgent action
 * is the SAME DAY it was raised (FSSAI_CA_DUE_DAYS.urgent = 0), so waiting a
 * day to escalate would mean a cold room at 9 °C is chased tomorrow.
 */
export interface FssaiEscalationRules {
  /** Master switch. false = nothing is sent at all, and the screen says so. */
  enabled: boolean;
  /** Tell the owner this many days BEFORE the due date. 0 = never. */
  remind_before_days: number;
  /** Tell the owner on the due date itself. */
  remind_on_due: boolean;
  /** Tell the owner again every day it stays late. */
  remind_overdue_daily: boolean;
  /** Days late before the first escalation. 0 = the day it goes late. */
  level1_after_days: number;
  /** Days late before the second. Must be >= level1. */
  level2_after_days: number;
  level1_targets: FssaiEscalationTarget[];
  level2_targets: FssaiEscalationTarget[];
  /** An URGENT action escalates the day it is raised, without waiting to be late. */
  urgent_escalates_same_day: boolean;
  /** Hours an action may sit with nobody's name on it before level 1 hears. 0 = never. */
  unassigned_escalates_after_hours: number;
  /** Also write a Slack row (only sent if settings.slack_webhook_url is set). */
  slack: boolean;
  /** Raise a Task-Manager job automatically when an action is raised. */
  auto_create_task: boolean;
}

export const FSSAI_ESCALATION_DEFAULTS: Readonly<FssaiEscalationRules> = {
  enabled: true,
  remind_before_days: 1,
  remind_on_due: true,
  remind_overdue_daily: true,
  level1_after_days: 1,
  level2_after_days: 3,
  level1_targets: ['manager', 'hod'],
  level2_targets: ['admin'],
  urgent_escalates_same_day: true,
  unassigned_escalates_after_hours: 4,
  slack: false,
  /**
   * OFF BY DEFAULT, DELIBERATELY, and this is the one default worth arguing
   * with. A task created automatically lands in somebody's list and pushes to
   * their phone; a restaurant whose questions are all flagged
   * `raise_ca_on_fail` would wake up to a task per failed answer. The button on
   * the action makes it one deliberate click, and an admin can switch this on
   * once he has seen what the volume really is.
   */
  auto_create_task: false,
};

const KEY = {
  enabled: 'fssai_esc_enabled',
  remind_before_days: 'fssai_esc_remind_before_days',
  remind_on_due: 'fssai_esc_remind_on_due',
  remind_overdue_daily: 'fssai_esc_remind_overdue_daily',
  level1_after_days: 'fssai_esc_level1_after_days',
  level2_after_days: 'fssai_esc_level2_after_days',
  level1_targets: 'fssai_esc_level1_targets',
  level2_targets: 'fssai_esc_level2_targets',
  urgent_escalates_same_day: 'fssai_esc_urgent_same_day',
  unassigned_escalates_after_hours: 'fssai_esc_unassigned_hours',
  slack: 'fssai_esc_slack',
  auto_create_task: 'fssai_esc_auto_task',
} as const;

/** The watermark that keeps a ride-along sweep from running on every page load. */
const LAST_SWEEP_KEY = 'fssai_esc_last_sweep_at';

function getSetting(db: Db, key: string): string | null {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any;
    return row?.value === undefined || row?.value === null ? null : String(row.value);
  } catch {
    return null;
  }
}

function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(value ?? ''));
}

/** '1'/'0'/'true'/'false' → boolean. An absent or unreadable value = the default. */
function boolSetting(db: Db, key: string, dflt: boolean): boolean {
  const raw = getSetting(db, key);
  if (raw === null || raw.trim() === '') return dflt;
  const s = raw.trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes') return true;
  if (s === '0' || s === 'false' || s === 'no') return false;
  return dflt;
}

/** A whole number within [min,max]. Anything else — including junk — is the default. */
function intSetting(db: Db, key: string, dflt: number, min: number, max: number): number {
  const raw = getSetting(db, key);
  if (raw === null || raw.trim() === '') return dflt;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < min || n > max) return dflt;
  return n;
}

function targetsSetting(db: Db, key: string, dflt: FssaiEscalationTarget[]): FssaiEscalationTarget[] {
  const raw = getSetting(db, key);
  if (raw === null || raw.trim() === '') return [...dflt];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...dflt];
    const list = parsed.filter(isFssaiEscalationTarget);
    // An EMPTY list is a real answer — "escalate to nobody at this level" — so
    // it is kept. Only an unreadable value falls back to the default.
    return list;
  } catch {
    return [...dflt];
  }
}

/**
 * The rules as the engine reads them. Total: it always returns a usable set,
 * because a food-safety chase must not stop because somebody typed "soon" into
 * a number field.
 */
export function readFssaiEscalationRules(db: Db): FssaiEscalationRules {
  const d = FSSAI_ESCALATION_DEFAULTS;
  const level1 = intSetting(db, KEY.level1_after_days, d.level1_after_days, 0, 365);
  const level2raw = intSetting(db, KEY.level2_after_days, d.level2_after_days, 0, 365);
  return {
    enabled: boolSetting(db, KEY.enabled, d.enabled),
    remind_before_days: intSetting(db, KEY.remind_before_days, d.remind_before_days, 0, 30),
    remind_on_due: boolSetting(db, KEY.remind_on_due, d.remind_on_due),
    remind_overdue_daily: boolSetting(db, KEY.remind_overdue_daily, d.remind_overdue_daily),
    level1_after_days: level1,
    // A second level that fires BEFORE the first is not a configuration, it is
    // a mistake — clamped on READ so a bad saved value cannot invert the ladder.
    level2_after_days: Math.max(level1, level2raw),
    level1_targets: targetsSetting(db, KEY.level1_targets, d.level1_targets),
    level2_targets: targetsSetting(db, KEY.level2_targets, d.level2_targets),
    urgent_escalates_same_day: boolSetting(db, KEY.urgent_escalates_same_day, d.urgent_escalates_same_day),
    unassigned_escalates_after_hours: intSetting(
      db, KEY.unassigned_escalates_after_hours, d.unassigned_escalates_after_hours, 0, 720,
    ),
    slack: boolSetting(db, KEY.slack, d.slack),
    auto_create_task: boolSetting(db, KEY.auto_create_task, d.auto_create_task),
  };
}

/**
 * Save the rules AND the trail. One transaction: a rule that changed with no
 * record of who changed it is exactly the hole RECON §2.5 warns about in
 * `settings`, so the audit row is not best-effort here — if it cannot be
 * written the change is rolled back and the admin is told.
 */
export function writeFssaiEscalationRules(
  db: Db,
  next: FssaiEscalationRules,
  actor: { email?: string | null; name?: string | null },
  outletId: string,
): FssaiEscalationRules {
  const before = readFssaiEscalationRules(db);
  const tx = db.transaction(() => {
    setSetting(db, KEY.enabled, next.enabled ? '1' : '0');
    setSetting(db, KEY.remind_before_days, String(next.remind_before_days));
    setSetting(db, KEY.remind_on_due, next.remind_on_due ? '1' : '0');
    setSetting(db, KEY.remind_overdue_daily, next.remind_overdue_daily ? '1' : '0');
    setSetting(db, KEY.level1_after_days, String(next.level1_after_days));
    setSetting(db, KEY.level2_after_days, String(next.level2_after_days));
    setSetting(db, KEY.level1_targets, JSON.stringify(next.level1_targets));
    setSetting(db, KEY.level2_targets, JSON.stringify(next.level2_targets));
    setSetting(db, KEY.urgent_escalates_same_day, next.urgent_escalates_same_day ? '1' : '0');
    setSetting(db, KEY.unassigned_escalates_after_hours, String(next.unassigned_escalates_after_hours));
    setSetting(db, KEY.slack, next.slack ? '1' : '0');
    setSetting(db, KEY.auto_create_task, next.auto_create_task ? '1' : '0');
    db.prepare(
      `INSERT INTO fssai_audit_log
         (id, entity_table, entity_id, action, field, before_json, after_json, reason,
          actor_email, actor_name, outlet_id)
       VALUES (?, 'fssai_escalation_rules', 'settings', 'update', 'rules', ?, ?, ?, ?, ?, ?)`,
    ).run(
      generateId(), JSON.stringify(before), JSON.stringify(next),
      'Chasing and escalation rules changed',
      actor.email || '', actor.name || '', outletId || '',
    );
  });
  tx();
  return readFssaiEscalationRules(db);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. THE TASK-MANAGER LINK (owner §21)
 * ════════════════════════════════════════════════════════════════════════ */

/** How a CA's task is labelled so it is obvious where it came from. */
export const FSSAI_TASK_SOURCE = 'fssai';

/**
 * WHICH TASK CATEGORY. 'Compliance' and 'Maintenance' are both already seeded
 * (src/lib/tasks.ts TASK_CATEGORIES, 13 of them) — FSSAI adds none. An action
 * about a piece of equipment is maintenance work; everything else is
 * compliance work, which is what the category list was waiting for.
 */
export function fssaiCaTaskCategory(ca: { equipment_id?: unknown }): string {
  return String(ca.equipment_id || '').trim() ? 'Maintenance' : 'Compliance';
}

/**
 * THE DEPARTMENT, MAPPED AND NEVER INVENTED.
 *
 * `tasks.department` is free text drawn from ten seeded names; FSSAI carries a
 * `departments.id` whose names in this restaurant are things like
 * "Akan Main Kitchen" and "Akan Perishables Bar". So: an exact match wins, then
 * a WHOLE-WORD match ("Akan Main Kitchen" → Kitchen, "Akan Housekeeping" →
 * Housekeeping), and anything else returns '' — an unfiltered task, never a
 * wrong one. HARD RULE 4: departments are the owner's to set, and nothing here
 * writes one.
 *
 * The real department name always travels in the task description, so the
 * mapping losing a match never loses the information.
 */
export function mapFssaiTaskDepartment(departmentName: unknown): string {
  const name = String(departmentName || '').trim();
  if (!name) return '';
  const exact = TASK_DEPARTMENTS.find((d) => d.toLowerCase() === name.toLowerCase());
  if (exact) return exact;
  const words = name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const hit = TASK_DEPARTMENTS.find((d) => words.includes(d.toLowerCase()));
  return hit || '';
}

export interface FssaiCaTaskLink {
  task_id: string;
  title: string;
  status: string;
  priority: string;
  category: string;
  department: string;
  assignee_email: string;
  due_date: string;
  is_archived: boolean;
  /** false when created_task_id points at a row that is no longer there. */
  exists: boolean;
}

/** The task behind one action, or null. `exists:false` when the row has gone. */
export function readFssaiCaTaskLink(db: Db, ca: { id: string; created_task_id?: unknown }): FssaiCaTaskLink | null {
  const taskId = String(ca.created_task_id || '').trim();
  if (!taskId) return null;
  const t = db.prepare(
    `SELECT id, title, status, priority, category, department, assignee_email, due_date, is_archived
       FROM tasks WHERE id = ?`,
  ).get(taskId) as any;
  if (!t) {
    return {
      task_id: taskId, title: '', status: '', priority: '', category: '', department: '',
      assignee_email: '', due_date: '', is_archived: false, exists: false,
    };
  }
  return {
    task_id: String(t.id),
    title: String(t.title || ''),
    status: String(t.status || ''),
    priority: String(t.priority || ''),
    category: String(t.category || ''),
    department: String(t.department || ''),
    assignee_email: String(t.assignee_email || ''),
    due_date: String(t.due_date || ''),
    is_archived: !!Number(t.is_archived),
    exists: true,
  };
}

/** Task links for a whole list, in one query. '' for actions with no task. */
export function readFssaiCaTaskLinks(db: Db, caIds: string[]): Record<string, FssaiCaTaskLink> {
  const out: Record<string, FssaiCaTaskLink> = {};
  if (!caIds.length) return out;
  const rows = db.prepare(
    `SELECT c.id AS ca_id, c.created_task_id AS created_task_id
       FROM fssai_corrective_actions c
      WHERE c.created_task_id <> '' AND c.id IN (${caIds.map(() => '?').join(',')})`,
  ).all(...caIds) as any[];
  for (const r of rows) {
    const link = readFssaiCaTaskLink(db, { id: String(r.ca_id), created_task_id: r.created_task_id });
    if (link) out[String(r.ca_id)] = link;
  }
  return out;
}

export interface FssaiCaTaskResult {
  task_id: string;
  created: boolean;
  /** The sentence to show. Always set, including when nothing was created. */
  message: string;
}

/**
 * MAKE THE FIX A JOB IN THE LIST STAFF ALREADY USE.
 *
 * The owner's §21 in one sentence: the corrective action is the compliance
 * record, the task is how a person is actually asked to do the work. Both, not
 * one pretending to be the other — so the task carries a link back in words and
 * the action carries the task id, and neither screen has to guess.
 *
 * SYNCHRONOUS AND IN ONE TRANSACTION, and the claim is the UPDATE itself:
 * `WHERE id=? AND created_task_id=''` means two people pressing the button at
 * the same moment produce ONE task. If the UPDATE does not change a row the
 * whole transaction rolls back and the already-created task is discarded with
 * it, so a double press can never leave an orphan job in somebody's list.
 *
 * NO MAINTENANCE SCHEDULE IS CREATED. `maintenance_schedules` is the owner's
 * recurring-work configuration (HARD RULE 4: read it, never write it), and a
 * one-off "mend this fridge" is not a recurring schedule. An equipment action
 * becomes a MAINTENANCE-category task, which is how it reaches the same board
 * and the same people, without this module inventing a schedule nobody asked
 * for.
 */
export function createFssaiCaTask(
  db: Db,
  input: {
    ca: any;
    actor: { email?: string | null; name?: string | null };
    assigneeEmail?: string;
    assigneeName?: string;
    priority?: string;
    dueDate?: string;
    note?: string;
    outletId?: string;
    /** 'auto' when the sweep raised it, 'manual' when somebody pressed the button. */
    origin?: 'auto' | 'manual';
  },
): FssaiCaTaskResult {
  const { ca, actor } = input;
  const caId = String(ca.id);

  const existing = readFssaiCaTaskLink(db, ca);
  if (existing && existing.exists) {
    return {
      task_id: existing.task_id, created: false,
      message: `This action is already a job in the Task Manager (${existing.title || existing.task_id}).`,
    };
  }
  if (existing && !existing.exists) {
    /* THE HONEST REFUSAL. created_task_id points somewhere, and the row is not
     * there — somebody deleted the task. Silently making a second one would
     * hide that, and the file would then have two task ids for one fault with
     * no record of the first. Said out loud instead. */
    return {
      task_id: existing.task_id, created: false,
      message: 'This action was already turned into a job, and that job is no longer in the Task Manager. '
        + 'Nothing has been created a second time — tell an administrator, because a deleted job is not a mended fault.',
    };
  }
  if (fssaiCaIsClosed(ca.status)) {
    return {
      task_id: '', created: false,
      message: 'That action is finished, so there is no work left to put in anybody\'s list.',
    };
  }

  const severity = isFssaiCaSeverity(ca.severity) ? String(ca.severity) : 'medium';
  /* THE SEVERITY *IS* THE PRIORITY. fssai.ts says so in words: the vocabulary
   * was taken from TASK_PRIORITIES verbatim precisely so this hand-off needs no
   * translation table that could drift. */
  const priority = ['low', 'medium', 'high', 'urgent'].includes(String(input.priority || ''))
    ? String(input.priority)
    : severity;
  const assigneeEmail = String(input.assigneeEmail || ca.owner_email || '').trim();
  const assigneeName = String(input.assigneeName || '').trim();
  const dueDate = isISODate(String(input.dueDate || '')) ? String(input.dueDate) : String(ca.due_date || '');
  const category = fssaiCaTaskCategory(ca);
  const department = mapFssaiTaskDepartment(ca.department_name);
  const status = assigneeEmail ? 'assigned' : 'draft';
  const caNumber = String(ca.ca_number || caId);
  const title = `FSSAI ${caNumber}: ${String(ca.title || 'Corrective action').trim()}`.slice(0, 300);

  /* THE DESCRIPTION CARRIES THE WHOLE STORY, because whoever picks this job up
   * may not be able to open /fssai/corrective-actions at all — and because a
   * task that says only "fix it" is the tick-box problem again. */
  const description = [
    String(ca.description || ca.title || '').trim(),
    ca.department_name ? `Department: ${String(ca.department_name)}.` : '',
    `Severity: ${fssaiCaSeverityMeta(severity).label}.`,
    String(input.note || '').trim(),
    `Raised from the food-safety record ${caNumber}. Record what you did on `
    + `/fssai/corrective-actions — completing this task does NOT close the compliance action, `
    + `and closing the action does not change the check that failed.`,
  ].filter(Boolean).join('\n');

  const taskId = generateId();
  let created = false;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks
         (id, title, description, category, department, priority, status,
          assignee_email, assignee_name, created_by, due_date,
          source, template_id, checklist_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '[]')`,
    ).run(
      taskId, title, description, category, department, priority, status,
      assigneeEmail, assigneeName, actor.email || '', dueDate, FSSAI_TASK_SOURCE,
    );
    db.prepare(
      `INSERT INTO task_status_history (id, task_id, from_status, to_status, changed_by, note)
       VALUES (?, ?, '', ?, ?, ?)`,
    ).run(
      generateId(), taskId, status, actor.email || '',
      input.origin === 'auto'
        ? `Raised automatically from food-safety corrective action ${caNumber}`
        : `Raised from food-safety corrective action ${caNumber}`,
    );
    if (assigneeEmail) {
      db.prepare(
        `INSERT INTO task_assignees (id, task_id, user_email, user_name) VALUES (?, ?, ?, ?)`,
      ).run(generateId(), taskId, assigneeEmail, assigneeName);
      db.prepare(
        `INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href)
         VALUES (?, ?, 'assignment', ?, ?, ?, '/tasks/my')`,
      ).run(generateId(), assigneeEmail, `Task assigned: ${title}`, description, taskId);
    }
    /* THE CLAIM. If another request won the race, changes is 0, this throws and
     * the INSERTs above are rolled back with it. */
    const res = db.prepare(
      `UPDATE fssai_corrective_actions
          SET created_task_id = ?, updated_at = datetime('now')
        WHERE id = ? AND created_task_id = ''`,
    ).run(taskId, caId);
    if (res.changes !== 1) throw new Error('FSSAI_CA_TASK_RACE');
    db.prepare(
      `INSERT INTO fssai_audit_log
         (id, entity_table, entity_id, action, field, before_json, after_json, reason,
          actor_email, actor_name, outlet_id)
       VALUES (?, 'fssai_corrective_actions', ?, 'update', 'created_task_id', ?, ?, ?, ?, ?, ?)`,
    ).run(
      generateId(), caId, JSON.stringify({ created_task_id: '' }),
      JSON.stringify({ created_task_id: taskId, task_status: status, assignee_email: assigneeEmail }),
      input.origin === 'auto'
        ? 'A job was raised automatically in the Task Manager for this corrective action'
        : 'A job was raised in the Task Manager for this corrective action',
      actor.email || '', actor.name || '', String(input.outletId || ca.outlet_id || ''),
    );
    created = true;
  });

  try {
    tx();
  } catch (e: any) {
    if (String(e?.message) === 'FSSAI_CA_TASK_RACE') {
      const now = readFssaiCaTaskLink(db, db.prepare(
        `SELECT id, created_task_id FROM fssai_corrective_actions WHERE id = ?`,
      ).get(caId) as any);
      return {
        task_id: now?.task_id || '', created: false,
        message: 'Somebody else turned this action into a job a moment ago. There is only one.',
      };
    }
    throw e;
  }

  // Push AFTER the transaction has committed, never inside it.
  if (created && assigneeEmail) {
    firePush(db, assigneeEmail, { title: `Task assigned: ${title}`, body: description, url: '/tasks/my' });
  }

  return {
    task_id: taskId,
    created,
    message: assigneeEmail
      ? `Added to the Task Manager and assigned to ${assigneeEmail}. Closing the job does not close this action — the fix still has to be recorded and checked here.`
      : 'Added to the Task Manager as a draft job. Give it an owner here or on the task board.',
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. THE CHASE (owner §23) — reminders and escalations
 * ════════════════════════════════════════════════════════════════════════ */

/** The five things this engine can say. The dedup key is built from these. */
export type FssaiAlertKind =
  | 'fssai_ca_due_soon'
  | 'fssai_ca_due_today'
  | 'fssai_ca_overdue'
  | 'fssai_ca_escalation_1'
  | 'fssai_ca_escalation_2'
  | 'fssai_ca_unassigned';

export const FSSAI_ALERT_KINDS: readonly { key: FssaiAlertKind; label: string }[] = [
  { key: 'fssai_ca_due_soon', label: 'Due soon' },
  { key: 'fssai_ca_due_today', label: 'Due today' },
  { key: 'fssai_ca_overdue', label: 'Late' },
  { key: 'fssai_ca_escalation_1', label: 'Escalated' },
  { key: 'fssai_ca_escalation_2', label: 'Escalated again' },
  { key: 'fssai_ca_unassigned', label: 'Nobody owns it' },
] as const;

export function fssaiAlertKindLabel(kind: string): string {
  return FSSAI_ALERT_KINDS.find((k) => k.key === kind)?.label || kind;
}

export interface FssaiSweepResult {
  ran: boolean;
  /** Why it did not run, when it did not: 'disabled' | 'throttled'. */
  skipped?: string;
  date: string;
  scanned: number;
  due_soon: number;
  due_today: number;
  overdue: number;
  unassigned: number;
  escalated_1: number;
  escalated_2: number;
  /** task_notifications rows written (one per person per claim). */
  people_told: number;
  /** Jobs raised in the Task Manager, only when auto_create_task is on. */
  tasks_created: number;
  slack_queued: number;
  errors: string[];
}

const EMPTY_SWEEP = (date: string): FssaiSweepResult => ({
  ran: false, date, scanned: 0, due_soon: 0, due_today: 0, overdue: 0, unassigned: 0,
  escalated_1: 0, escalated_2: 0, people_told: 0, tasks_created: 0, slack_queued: 0, errors: [],
});

function firePush(db: Db, email: string, payload: { title: string; body: string; url?: string }): void {
  try {
    if (!email) return;
    Promise.resolve().then(() => sendPushToUser(db, email, payload)).catch(() => { /* never */ });
  } catch { /* never throw */ }
}

/**
 * Resolve a target list to real, active sign-in addresses.
 *
 * A TIER IS RESOLVED BOTH WAYS, because this app has two. `users.role` carries
 * the tier directly, and `users.role_id` → `roles.base_role` carries it when a
 * named role is assigned. RECON §5 measured role_id as set on 0 of 9 users, so
 * reading only the named role would reach NOBODY today and reading only the
 * column would reach nobody the day he starts using roles. Both.
 */
function resolveTargets(
  db: Db,
  targets: FssaiEscalationTarget[],
  ca: { owner_email?: unknown; run_recorded_by?: unknown; department_id?: unknown },
): string[] {
  const out = new Set<string>();
  const add = (e: unknown) => {
    const s = String(e || '').trim();
    if (s) out.add(s.toLowerCase());
  };

  const tiers: string[] = [];
  let wantHod = false;
  for (const t of targets) {
    if (t === 'owner') add(ca.owner_email);
    else if (t === 'recorder') add(ca.run_recorded_by);
    else if (t === 'hod') wantHod = true;
    else tiers.push(t);           // 'manager' | 'admin'
  }

  try {
    if (tiers.length) {
      const rows = db.prepare(
        `SELECT DISTINCT u.email AS email
           FROM users u
           LEFT JOIN roles r ON r.id = u.role_id
          WHERE u.is_active = 1
            AND (lower(IFNULL(u.role,'')) IN (${tiers.map(() => '?').join(',')})
                 OR lower(IFNULL(r.base_role,'')) IN (${tiers.map(() => '?').join(',')}))`,
      ).all(...tiers, ...tiers) as any[];
      for (const r of rows) add(r.email);
    }
    if (wantHod) {
      /* A HEAD OF DEPARTMENT, AND THE DEPARTMENT'S OWN HEAD FIRST. An action in
       * the Main Kitchen escalating to the bar's head chef is noise; escalating
       * to nobody because that department has no head is worse. So: the heads of
       * THIS department if there are any, otherwise every head. */
      const scoped = String(ca.department_id || '').trim()
        ? db.prepare(
          `SELECT DISTINCT u.email AS email
             FROM users u LEFT JOIN roles r ON r.id = u.role_id
            WHERE u.is_active = 1 AND u.department_id = ?
              AND (u.is_head_chef = 1 OR IFNULL(r.is_head_chef,0) = 1)`,
        ).all(String(ca.department_id)) as any[]
        : [];
      const rows = scoped.length
        ? scoped
        : db.prepare(
          `SELECT DISTINCT u.email AS email
             FROM users u LEFT JOIN roles r ON r.id = u.role_id
            WHERE u.is_active = 1 AND (u.is_head_chef = 1 OR IFNULL(r.is_head_chef,0) = 1)`,
        ).all() as any[];
      for (const r of rows) add(r.email);
    }
  } catch (e) {
    console.error('[fssai-alerts] could not resolve escalation targets:', e);
  }
  return [...out];
}

/** The words a person reads. Written once so the Slack line and the bell agree. */
function wording(
  kind: FssaiAlertKind,
  ca: any,
  daysLate: number,
): { title: string; body: string } {
  const num = String(ca.ca_number || '');
  const what = String(ca.title || 'A corrective action');
  const where = [String(ca.department_name || ''), String(ca.run_target_label || '')].filter(Boolean).join(' · ');
  const owner = String(ca.owner_email || '').trim();
  const tail = where ? ` (${where})` : '';
  const sev = fssaiCaSeverityMeta(ca.severity).label.toLowerCase();

  switch (kind) {
    case 'fssai_ca_due_soon':
      return {
        title: `Due ${ca.due_date}: ${num}`,
        body: `“${what}”${tail} is due on ${ca.due_date}. It is still open.`,
      };
    case 'fssai_ca_due_today':
      return {
        title: `Due today: ${num}`,
        body: `“${what}”${tail} is due today and still open.`,
      };
    case 'fssai_ca_overdue':
      return {
        title: `Late by ${daysLate} day${daysLate === 1 ? '' : 's'}: ${num}`,
        body: `“${what}”${tail} was due ${ca.due_date} and is still open.`,
      };
    case 'fssai_ca_unassigned':
      return {
        title: `Nobody owns ${num}`,
        body: `A ${sev} food-safety failure — “${what}”${tail} — has had no owner since it was raised. `
          + `Give it to somebody on /fssai/corrective-actions.`,
      };
    case 'fssai_ca_escalation_1':
      return {
        title: `Escalation: ${num} is ${daysLate} day${daysLate === 1 ? '' : 's'} late`,
        body: `“${what}”${tail} is a ${sev} food-safety failure that is still not fixed`
          + `${owner ? `, assigned to ${owner}` : ' and has no owner'}.`,
      };
    case 'fssai_ca_escalation_2':
      return {
        title: `Second escalation: ${num} is ${daysLate} day${daysLate === 1 ? '' : 's'} late`,
        body: `“${what}”${tail} is a ${sev} food-safety failure, ${daysLate} days past its date`
          + `${owner ? `, still with ${owner}` : ' and still with nobody'}. This is the second time it has been escalated.`,
      };
  }
}

/**
 * CHASE EVERY OPEN CORRECTIVE ACTION, ONCE A DAY PER THING TO SAY.
 *
 * Best-effort by contract: it swallows its own errors and never throws into a
 * request, exactly as the Task module's sweep and the kitchen-expiry watchdog
 * do. A chase that breaks a screen is worse than a chase that misses a day.
 *
 * READS the frozen row and WRITES only notifications plus one audit row per
 * claim. It does not move a status, does not touch a due date, and cannot
 * change a record: an action that is late stays exactly as late as it is.
 *
 * `force` skips the throttle (the button on the screen); without it a sweep
 * that ran in the last THROTTLE_MIN minutes is a no-op, so this can safely ride
 * along on a page load without hammering the database.
 */
const THROTTLE_MIN = 10;

export function sweepFssaiCaAlerts(
  db: Db,
  opts: { force?: boolean; today?: string } = {},
): FssaiSweepResult {
  const today = opts.today && isISODate(opts.today) ? opts.today : fssaiToday();
  const result = EMPTY_SWEEP(today);

  let rules: FssaiEscalationRules;
  try {
    rules = readFssaiEscalationRules(db);
  } catch (e: any) {
    result.errors.push(`rules: ${e?.message || e}`);
    return result;
  }
  if (!rules.enabled) return { ...result, skipped: 'disabled' };

  if (!opts.force) {
    const last = getSetting(db, LAST_SWEEP_KEY);
    if (last) {
      const ms = Date.parse(last.includes('T') ? last : `${last.replace(' ', 'T')}Z`);
      if (Number.isFinite(ms) && Date.now() - ms < THROTTLE_MIN * 60_000) {
        return { ...result, skipped: 'throttled' };
      }
    }
  }

  const slackQueue: { key: string; kind: string; title: string; body: string }[] = [];

  try {
    const rows = db.prepare(
      /* `live_task_id` is NOT c.created_task_id. A notification carries a task id
       * only when that task ROW STILL EXISTS: somebody deleting the job must not
       * leave every later note pointing at a task nobody can open. The dangling
       * created_task_id is still read separately below, because it must keep
       * BLOCKING a silent re-create. */
      `SELECT c.id, c.ca_number, c.title, c.severity, c.status, c.owner_email, c.due_date,
              c.department_id, c.created_at, c.outlet_id, c.created_task_id,
              IFNULL(tk.id,'') AS live_task_id,
              d.name AS department_name,
              r.recorded_by AS run_recorded_by, r.target_label AS run_target_label
         FROM fssai_corrective_actions c
         LEFT JOIN departments d ON d.id = c.department_id
         LEFT JOIN fssai_runs   r ON r.id = c.run_id
         LEFT JOIN tasks        tk ON tk.id = c.created_task_id
        WHERE c.status IN ('open','in_progress','done')
        ORDER BY c.created_at ASC`,
    ).all() as any[];
    result.scanned = rows.length;

    const claim = db.prepare(
      `INSERT OR IGNORE INTO notifications
         (id, kind, party_unique_id, fp_id, event_name, event_date, channel, recipient, title, body)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    );
    const tell = db.prepare(
      `INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href)
       VALUES (?, ?, ?, ?, ?, ?, '/fssai/corrective-actions')`,
    );

    /** One thing to say about one action, on one day, to a set of people. */
    const say = (
      ca: any, kind: FssaiAlertKind, recipients: string[], daysLate: number,
    ): boolean => {
      const people = [...new Set(recipients.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
      if (!people.length) return false;
      const dedupKey = `fssai-ca:${ca.id}:${today}`;
      const w = wording(kind, ca, daysLate);
      let won = false;

      const tx = db.transaction(() => {
        const r = claim.run(
          generateId(), kind, dedupKey, String(ca.ca_number || ''), today,
          'inapp', people.join(','), w.title, w.body,
        );
        if (r.changes === 0) return;           // already said today
        won = true;
        for (const email of people) {
          /* task_id carries the LIVE linked task when there is one so the feed
           * row can be followed into the Task Manager, and '' otherwise — never
           * the action's id, and never a task id that no longer resolves (both
           * would send a reader looking for something that is not there). href
           * is always the action itself. */
          tell.run(generateId(), email, kind, w.title, w.body, String(ca.live_task_id || ''));
          result.people_told += 1;
        }
        if (rules.slack) {
          const rs = claim.run(
            generateId(), kind, dedupKey, String(ca.ca_number || ''), today,
            'slack', people.join(','), w.title, w.body,
          );
          if (rs.changes > 0) slackQueue.push({ key: dedupKey, kind, title: w.title, body: w.body });
        }
        /* THE COMPLIANCE TRAIL. §19 wants to be able to show that somebody was
         * told — "nobody chased it" and "everybody was told and nobody acted"
         * are completely different findings, and only one of them is the
         * software's fault. Best-effort: a missing log row must not stop the
         * chase it describes. */
        fssaiAuditBestEffort(db, {
          entity_table: 'fssai_corrective_actions', entity_id: String(ca.id),
          action: 'escalate', field: kind,
          after: { kind, recipients: people, days_late: daysLate, business_date: today },
          reason: w.title,
          actor: { email: 'system', name: 'Chasing and escalation' },
          outlet_id: String(ca.outlet_id || ''),
        });
      });
      try {
        tx();
      } catch (e: any) {
        result.errors.push(`${ca.ca_number || ca.id} ${kind}: ${e?.message || e}`);
        return false;
      }
      return won;
    };

    for (const ca of rows) {
      if (fssaiCaIsClosed(ca.status)) continue;      // belt to the WHERE's braces
      const due = String(ca.due_date || '');
      const owner = String(ca.owner_email || '').trim();
      const severity = isFssaiCaSeverity(ca.severity) ? String(ca.severity) : 'medium';

      /* ── THE JOB IN THE TASK MANAGER, IF THE ADMIN ASKED FOR ONE (§21) ───
       * OFF by default (FSSAI_ESCALATION_DEFAULTS.auto_create_task), so on a
       * restaurant that has not opted in this is an `if` that never runs. When
       * it IS on, it is idempotent through `created_task_id` — the UPDATE's own
       * `WHERE created_task_id=''` is the claim, so this sweep running twice
       * cannot produce two jobs for one fault. Wrapped: a task that will not
       * insert must not stop the reminders below it. */
      if (rules.auto_create_task && !String(ca.created_task_id || '').trim()) {
        try {
          const made = createFssaiCaTask(db, {
            ca,
            actor: { email: 'system', name: 'Food safety' },
            outletId: String(ca.outlet_id || ''),
            origin: 'auto',
          });
          if (made.created) {
            result.tasks_created += 1;
            // Keep the in-memory row honest so `say()` links the new task.
            ca.created_task_id = made.task_id;
            ca.live_task_id = made.task_id;
          }
        } catch (e: any) {
          result.errors.push(`${ca.ca_number || ca.id} task: ${e?.message || e}`);
        }
      }

      /* ── NOBODY OWNS IT ────────────────────────────────────────────────
       * Measured before anything else because it is the failure mode the
       * raise path builds in on purpose: an action starts with no owner
       * (raiseFssaiCorrectiveActions leaves owner_email '' rather than guess),
       * so without this an unassigned urgent failure is chased by nobody —
       * there is no owner to remind. */
      if (!owner && rules.unassigned_escalates_after_hours > 0) {
        const createdMs = Date.parse(String(ca.created_at || '').replace(' ', 'T') + 'Z');
        const ageH = Number.isFinite(createdMs) ? (Date.now() - createdMs) / 3_600_000 : 0;
        if (ageH >= rules.unassigned_escalates_after_hours) {
          if (say(ca, 'fssai_ca_unassigned', resolveTargets(db, rules.level1_targets, ca), 0)) {
            result.unassigned += 1;
          }
        }
      }

      /* ── AN URGENT ACTION DOES NOT WAIT TO BE LATE ─────────────────────── */
      if (rules.urgent_escalates_same_day && severity === 'urgent') {
        if (say(ca, 'fssai_ca_escalation_1', resolveTargets(db, rules.level1_targets, ca), 0)) {
          result.escalated_1 += 1;
        }
      }

      if (!isISODate(due)) continue;                 // no date = nothing to be late for
      // Positive when the due date has passed. daysBetweenISO(from,to) counts forward.
      const daysLate = daysBetweenISO(due, today);

      if (daysLate < 0) {
        /* ── DUE SOON — the only alert that is not about a failure to act ── */
        const daysToGo = -daysLate;
        if (rules.remind_before_days > 0 && daysToGo <= rules.remind_before_days && owner) {
          if (say(ca, 'fssai_ca_due_soon', [owner], 0)) result.due_soon += 1;
        }
        continue;
      }

      if (daysLate === 0) {
        if (rules.remind_on_due && owner) {
          if (say(ca, 'fssai_ca_due_today', [owner], 0)) result.due_today += 1;
        }
      } else if (rules.remind_overdue_daily && owner) {
        if (say(ca, 'fssai_ca_overdue', [owner], daysLate)) result.overdue += 1;
      }

      /* ── THE LADDER. Level 2 wins when both apply: a person hearing about
       * the same action twice in one day learns to ignore both. */
      if (daysLate >= rules.level2_after_days && rules.level2_targets.length) {
        if (say(ca, 'fssai_ca_escalation_2', resolveTargets(db, rules.level2_targets, ca), daysLate)) {
          result.escalated_2 += 1;
        }
      } else if (daysLate >= rules.level1_after_days && rules.level1_targets.length) {
        if (say(ca, 'fssai_ca_escalation_1', resolveTargets(db, rules.level1_targets, ca), daysLate)) {
          result.escalated_1 += 1;
        }
      }
    }

    result.ran = true;
    try { setSetting(db, LAST_SWEEP_KEY, new Date().toISOString()); } catch { /* best-effort */ }
  } catch (e: any) {
    result.errors.push(`sweep: ${e?.message || e}`);
    console.error('[fssai-alerts] sweep failed:', e);
    return result;
  }

  result.slack_queued = slackQueue.length;

  /* Web push, after every transaction above has committed. One per person per
   * claim, deferred so a push failure can never reach the caller. */
  try {
    const unread = db.prepare(
      `SELECT recipient_email AS email, title, body FROM task_notifications
        WHERE kind LIKE 'fssai_ca_%' AND is_read = 0 AND created_at >= datetime('now','-2 minutes')`,
    ).all() as any[];
    for (const u of unread) {
      firePush(db, String(u.email), {
        title: String(u.title), body: String(u.body), url: '/fssai/corrective-actions',
      });
    }
  } catch (e: any) {
    result.errors.push(`push: ${e?.message || e}`);
  }

  return result;
}

/**
 * Dispatch the Slack rows this sweep queued. SEPARATE AND ASYNC on purpose —
 * the sweep itself is synchronous (better-sqlite3 is, and `await` inside a
 * transaction is the trap HARD RULE 1 names), so the network call cannot live
 * inside it. Claims the row through sent_at exactly as kitchen-expiry does, so
 * two callers cannot double-send.
 */
export async function flushFssaiAlertSlack(db: Db): Promise<{ sent: number; errors: string[] }> {
  const errors: string[] = [];
  let sent = 0;
  try {
    const hook = String((db.prepare(
      `SELECT value FROM settings WHERE key = 'slack_webhook_url'`,
    ).get() as any)?.value || '').trim();
    if (!hook) return { sent, errors };
    const rows = db.prepare(
      `SELECT party_unique_id AS key, kind, title, body FROM notifications
        WHERE channel = 'slack' AND sent_at IS NULL AND kind LIKE 'fssai_ca_%'
        ORDER BY created_at ASC LIMIT 50`,
    ).all() as any[];
    for (const r of rows) {
      try {
        const resp = await fetch(hook, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `${r.title}\n${r.body}` }),
        });
        if (resp.ok) {
          sent += 1;
          db.prepare(
            `UPDATE notifications SET sent_at = datetime('now'), delivery_meta = 'ok'
              WHERE party_unique_id = ? AND kind = ? AND channel = 'slack' AND sent_at IS NULL`,
          ).run(r.key, r.kind);
        } else {
          errors.push(`Slack ${resp.status}: ${r.title}`);
        }
      } catch (e: any) {
        errors.push(`Slack ${e?.message}: ${r.title}`);
      }
    }
  } catch (e: any) {
    errors.push(`slack flush: ${e?.message || e}`);
  }
  return { sent, errors };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. WHAT WAS SAID — so a screen can show the chase, not just promise it
 * ════════════════════════════════════════════════════════════════════════ */

export interface FssaiCaAlertEvent {
  kind: string;
  kind_label: string;
  at: string;
  recipients: string[];
  days_late: number;
}

/**
 * Every reminder and escalation recorded against one action, newest first, read
 * out of the audit trail rather than recomputed — so the screen shows what was
 * actually sent, not what today's rules would send.
 */
export function readFssaiCaAlertTrail(db: Db, caId: string, limit = 50): FssaiCaAlertEvent[] {
  try {
    const rows = db.prepare(
      `SELECT field, after_json, created_at FROM fssai_audit_log
        WHERE entity_table = 'fssai_corrective_actions' AND entity_id = ? AND action = 'escalate'
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(caId, limit) as any[];
    return rows.map((r) => {
      let after: any = {};
      try { after = JSON.parse(String(r.after_json || '{}')) || {}; } catch { after = {}; }
      return {
        kind: String(r.field || after.kind || ''),
        kind_label: fssaiAlertKindLabel(String(r.field || after.kind || '')),
        at: String(r.created_at || ''),
        recipients: Array.isArray(after.recipients) ? after.recipients.map(String) : [],
        days_late: Number(after.days_late) || 0,
      };
    });
  } catch {
    return [];
  }
}

/**
 * The live picture the escalation screen leads with. Computed, never stored:
 * tightening a rule must not retrospectively relabel what was sent yesterday
 * (HARD RULE 3's reasoning, applied to an alert instead of a reading).
 */
export function fssaiEscalationPicture(db: Db, today = fssaiToday()) {
  const base = {
    outstanding: 0, unassigned: 0, due_today: 0, overdue: 0, overdue_urgent: 0,
    worst_days_late: 0, with_task: 0, told_today: 0, last_sweep_at: '',
  };
  try {
    const r = db.prepare(
      `SELECT
         COUNT(*) AS outstanding,
         SUM(CASE WHEN owner_email = '' THEN 1 ELSE 0 END) AS unassigned,
         SUM(CASE WHEN due_date = ? THEN 1 ELSE 0 END) AS due_today,
         SUM(CASE WHEN due_date <> '' AND due_date < ? THEN 1 ELSE 0 END) AS overdue,
         SUM(CASE WHEN due_date <> '' AND due_date < ? AND severity = 'urgent' THEN 1 ELSE 0 END) AS overdue_urgent,
         SUM(CASE WHEN created_task_id <> '' THEN 1 ELSE 0 END) AS with_task,
         MIN(CASE WHEN due_date <> '' AND due_date < ? THEN due_date ELSE NULL END) AS oldest_due
       FROM fssai_corrective_actions
      WHERE status IN ('open','in_progress','done')`,
    ).get(today, today, today, today) as any;
    base.outstanding = Number(r?.outstanding) || 0;
    base.unassigned = Number(r?.unassigned) || 0;
    base.due_today = Number(r?.due_today) || 0;
    base.overdue = Number(r?.overdue) || 0;
    base.overdue_urgent = Number(r?.overdue_urgent) || 0;
    base.with_task = Number(r?.with_task) || 0;
    const oldest = String(r?.oldest_due || '');
    base.worst_days_late = isISODate(oldest) ? Math.max(0, daysBetweenISO(oldest, today)) : 0;
    base.told_today = Number((db.prepare(
      `SELECT COUNT(*) AS n FROM task_notifications
        WHERE kind LIKE 'fssai_ca_%' AND substr(created_at,1,10) = ?`,
    ).get(today) as any)?.n) || 0;
    base.last_sweep_at = getSetting(db, LAST_SWEEP_KEY) || '';
  } catch (e) {
    console.error('[fssai-alerts] picture failed:', e);
  }
  return base;
}
