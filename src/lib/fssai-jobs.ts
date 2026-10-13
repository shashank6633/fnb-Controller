/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FSSAI — THE THREE UNATTENDED JOBS, AND THE ONLY THING THAT DRIVES THEM.
 *
 * Called once per scheduler tick from src/lib/scheduler.ts, which is armed at
 * server boot from register() in src/instrumentation.ts. That is the app's one
 * mechanism for background work and this file adds no second one: there is no
 * /api/cron route here, because src/proxy.ts answers a token-only POST to any
 * /api route with 401 before the handler runs (the recorded trap), and a cron
 * guard nothing can reach is a guard that never fires.
 *
 * Until this file existed all three of these had MANUAL CALLERS ONLY:
 *
 *   1. THE ESCALATION LADDER — sweepFssaiCaAlerts (src/lib/fssai-alerts.ts).
 *      Ran only as a ride-along on GET /api/fssai/corrective-actions and from
 *      "Chase now". So a late corrective action was chased only on a day
 *      somebody happened to open that queue — the inert-guard shape exactly.
 *      WIRED, NOT REWRITTEN: this file calls it as-is. It is throttled (10 min)
 *      and deduped per (action, kind, IST day) by its own UNIQUE claim, so the
 *      tick, the page and the button cannot double-nag anybody.
 *
 *   2. THE 12-MONTH PHOTO RETENTION SWEEP — sweepFssaiPhotoRetention
 *      (src/lib/fssai-retention.ts), owner §7 Q13. It DELETES IMAGE DATA, and
 *      unattended, so it is wrapped in a guard (runFssaiRetentionJob below) that
 *      refuses rather than proceeds whenever it cannot PROVE every image it is
 *      about to drop is at least twelve months old, and that makes sure every
 *      scheduled pass — swept, refused or failed — leaves an
 *      fssai_retention_runs row.
 *
 *   3. MISSED-CHECK REMINDERS — there was NO existing function for this
 *      (FSSAI-BUILD-STATE.md, P3 row: "any due/overdue reminder" not built), so
 *      it is the one piece of logic this file owns. It reads the SAME slot rule
 *      the dashboard and the runner use and the module's single calendar
 *      implementation (fssaiNextDueDate); it writes notifications, never a
 *      record. See runFssaiMissedCheckReminders.
 *
 * WHAT THIS FILE NEVER DOES: write fssai_runs, fssai_responses, an assignment,
 * a template, a department, a role or a mapping. Its only writes are
 * `notifications` (the claim), `task_notifications` (the bell),
 * `fssai_audit_log` (the trail), `fssai_retention_runs` (the proof — and only
 * for a refusal or a lost proof row; a real sweep writes its own) and three
 * `settings` keys under `fssai_job_*` (once-a-day watermarks + a heartbeat).
 *
 * better-sqlite3 IS SYNCHRONOUS: every db.transaction() below is a plain
 * synchronous function. The only `await` in this file is the Slack flush, which
 * is outside every transaction (fssai-alerts.ts already split it out for exactly
 * that reason).
 */
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
import {
  FSSAI_PHOTO_RETENTION_MONTHS, fssaiToday, addDaysISO, isISODate, fssaiNextDueDate,
  isFssaiFrequency, type FssaiFrequency,
} from '@/lib/fssai';
import { sweepFssaiPhotoRetention } from '@/lib/fssai-retention';
import {
  sweepFssaiCaAlerts, flushFssaiAlertSlack, readFssaiEscalationRules, type FssaiSweepResult,
} from '@/lib/fssai-alerts';
import { fssaiAuditBestEffort } from '@/lib/fssai-server';
import { sendPushToUser } from '@/lib/push';

type Db = Database.Database;

/* ══════════════════════════════════════════════════════════════════════════
 * SHARED PLUMBING
 * ════════════════════════════════════════════════════════════════════════ */

/** IST hour (0-23) of an instant, independent of the host timezone (fssaiToday's own +5.5h rule). */
function istHourOf(now: Date): number {
  return new Date(now.getTime() + 5.5 * 3600_000).getUTCHours();
}

function getSetting(db: Db, key: string): string | null {
  try {
    const r = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any;
    return r?.value === undefined || r?.value === null ? null : String(r.value);
  } catch {
    return null;
  }
}

function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/**
 * Claim a once-per-day slot ATOMICALLY. True for exactly one caller per day.
 *
 * The upsert only writes when the stored day differs, so of two pm2 workers
 * racing the same tick one gets changes=1 and the other changes=0 — a SQLite
 * write, not a read-then-write.
 */
function claimDay(db: Db, key: string, day: string): boolean {
  const r = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value <> excluded.value`,
  ).run(key, day);
  return r.changes === 1;
}

function tableExists(db: Db, name: string): boolean {
  try {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
  } catch {
    return false;
  }
}

/**
 * Parse a stored timestamp to epoch ms, or NaN when its age cannot be PROVED.
 *
 * SQLite's datetime('now') writes 'YYYY-MM-DD HH:MM:SS' in UTC with no zone; an
 * ISO instant carries 'T' and usually 'Z'. Anything else — '', a bare date, a
 * locale string — is NaN, and the retention guard treats NaN as "might be
 * young" and refuses.
 */
function parseStoredInstant(v: unknown): number {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) return NaN;
  const iso = s.replace(' ', 'T');
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`;
  return Date.parse(zoned);
}

const KEY_RETENTION_DAY = 'fssai_job_retention_day';
const KEY_MISSED_DAY = 'fssai_job_missed_checks_day';
const KEY_HEARTBEAT = 'fssai_job_heartbeat';

/* ══════════════════════════════════════════════════════════════════════════
 * 1. THE ESCALATION LADDER — wired, not rewritten
 * ════════════════════════════════════════════════════════════════════════ */

export interface FssaiEscalationJobResult {
  sweep: FssaiSweepResult;
  slack_sent: number;
  slack_errors: string[];
}

/**
 * One pass of the corrective-action chase. Every tick is safe: the sweep
 * returns 'throttled' inside its own 10-minute window and each thing it says is
 * claimed once per (action, kind, IST day) on notifications' UNIQUE index.
 * NOT forced — forcing is the "Chase now" button's privilege.
 */
export async function runFssaiEscalationJob(db: Db): Promise<FssaiEscalationJobResult> {
  const sweep = sweepFssaiCaAlerts(db);           // synchronous; never throws by contract
  // Outside every transaction: the network call is the reason it is separate.
  const slack = await flushFssaiAlertSlack(db);   // no webhook configured = returns at once
  return { sweep, slack_sent: slack.sent, slack_errors: slack.errors };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. THE 12-MONTH PHOTO RETENTION SWEEP — guarded
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * THE FLOOR. The owner ruled twelve months (§7 Q13). This number is deliberately
 * a SECOND copy, independent of FSSAI_PHOTO_RETENTION_MONTHS: if somebody edits
 * that constant to 1 the scheduled sweep refuses instead of quietly dropping
 * eleven months of photographs. Raising the window (keeping MORE) passes; going
 * below the floor needs this line changed too, on purpose.
 */
export const FSSAI_RETENTION_FLOOR_MONTHS = 12;

/** Not before 03:00 IST — the quietest hour, nobody is taking photographs. */
const RETENTION_EARLIEST_IST_HOUR = 3;

export type FssaiRetentionJobOutcome = 'not_due' | 'already_ran_today' | 'swept' | 'refused' | 'failed';

export interface FssaiRetentionJobResult {
  outcome: FssaiRetentionJobOutcome;
  /** IST date this pass belongs to. */
  day: string;
  detail: string;
  /** The fssai_retention_runs row this pass wrote. '' only for not_due / already_ran_today. */
  retention_run_id: string;
  months_configured: number;
  /** ISO instant: nothing created after this may be dropped, whatever the configuration says. */
  floor_cutoff: string;
  candidates: number;
  dropped: number;
  still_held: number;
  bytes_freed: number;
}

/** The instant twelve calendar months before `now` (UTC month arithmetic). */
export function fssaiRetentionFloorCutoff(now: Date): string {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - FSSAI_RETENTION_FLOOR_MONTHS);
  return d.toISOString();
}

/** Write the proof row for a pass that did NOT sweep. Returns its id, or '' if even that failed. */
function writeRefusalRow(
  db: Db, p: { cutoff: string; months: number; scanned: number; detail: string },
): string {
  const id = generateId();
  try {
    db.prepare(
      `INSERT INTO fssai_retention_runs
         (id, finished_at, cutoff_date, months_kept, scanned_count, dropped_count, status, detail, triggered_by)
       VALUES (?, datetime('now'), ?, ?, ?, 0, 'failed', ?, 'scheduler')`,
    ).run(id, p.cutoff, Number.isInteger(p.months) ? p.months : 0, p.scanned, p.detail.slice(0, 1000));
    return id;
  } catch (e: any) {
    console.error('[fssai-jobs] retention REFUSED and its proof row could not be written:', e?.message, '—', p.detail);
    return '';
  }
}

/**
 * ONE SCHEDULED RETENTION PASS PER IST DAY, AND ONLY IF IT CAN PROVE ITSELF.
 *
 * The order is the guarantee:
 *   1. not before 03:00 IST, and at most once per IST day (atomic claim);
 *   2. the proof table must exist — a pass that cannot record what it did does
 *      not do it;
 *   3. the configured window must be a whole number >= the 12-month FLOOR;
 *   4. a DRY RUN with the exact same `now` and `months` the real pass will use,
 *      and every candidate it names is checked HERE, independently of the
 *      sweep's own SQL: its created_at must parse, and must be at or before the
 *      floor cutoff. One row that fails either test refuses the whole pass —
 *      the sweep has no per-row exclusion, and an image whose age cannot be
 *      proved is treated as young. (Measured reason, not theory: the sweep's
 *      string comparison `replace(created_at,' ','T') <= cutoff` puts '' and any
 *      non-ISO date BEFORE every cutoff, so on its own it would drop them.)
 *   5. only then the real sweep, which writes its own 'running' → 'done' row;
 *      if that row is missing afterwards, one is written here so the pass is
 *      never invisible;
 *   6. the row's detail is stamped with what the guard checked.
 * Every refusal writes a 'failed' row saying why, so "refused" is as visible in
 * fssai_retention_runs as "swept".
 */
export function runFssaiRetentionJob(
  db: Db,
  opts: { now?: Date; configuredMonths?: number } = {},
): FssaiRetentionJobResult {
  const now = opts.now ?? new Date();
  const configured = opts.configuredMonths ?? FSSAI_PHOTO_RETENTION_MONTHS;
  const validNow = Number.isFinite(now.getTime());
  const day = validNow ? fssaiToday(now) : '';
  const floorCutoff = validNow ? fssaiRetentionFloorCutoff(now) : '';
  const res: FssaiRetentionJobResult = {
    outcome: 'not_due', day, detail: '', retention_run_id: '', months_configured: configured,
    floor_cutoff: floorCutoff, candidates: 0, dropped: 0, still_held: 0, bytes_freed: 0,
  };

  if (!validNow) {
    res.outcome = 'refused';
    res.detail = 'Refused by the scheduler guard: the clock did not give a usable time.';
    res.retention_run_id = writeRefusalRow(db, { cutoff: '', months: configured, scanned: 0, detail: res.detail });
    return res;
  }
  if (istHourOf(now) < RETENTION_EARLIEST_IST_HOUR) {
    res.detail = `Runs from ${RETENTION_EARLIEST_IST_HOUR}:00 IST.`;
    return res;
  }

  // (2) BEFORE the day is claimed: a database whose cold start predates the
  // proof table must not burn the day — it simply is not ready.
  if (!tableExists(db, 'fssai_retention_runs')) {
    res.outcome = 'refused';
    res.detail = 'Refused: fssai_retention_runs is not in this database, so the sweep could not prove what it did. Nothing was dropped.';
    console.error(`[fssai-jobs] retention ${res.detail}`);
    return res;
  }

  // (1)
  if (!claimDay(db, KEY_RETENTION_DAY, day)) {
    res.outcome = 'already_ran_today';
    res.detail = `Already ran for ${day}.`;
    return res;
  }

  // (3)
  if (!Number.isInteger(configured) || configured < FSSAI_RETENTION_FLOOR_MONTHS) {
    res.outcome = 'refused';
    res.detail = `Refused by the scheduler guard: the configured window is ${String(configured)} month(s), below the owner's ruled ${FSSAI_RETENTION_FLOOR_MONTHS}-month floor (§7 Q13). Nothing was dropped.`;
    res.retention_run_id = writeRefusalRow(db, { cutoff: floorCutoff, months: configured, scanned: 0, detail: res.detail });
    console.error(`[fssai-jobs] retention ${res.detail}`);
    return res;
  }

  let rowidBefore = -1;   // -1 = the real sweep has not started
  try {
    // (4)
    const dry = sweepFssaiPhotoRetention(db, { now, months: configured, dryRun: true });
    res.candidates = dry.candidates;
    res.still_held = dry.still_held;
    const floorMs = Date.parse(floorCutoff);
    const dryCutoffMs = Date.parse(dry.cutoff);
    const problems: string[] = [];
    if (!Number.isFinite(dryCutoffMs) || dryCutoffMs > floorMs) {
      problems.push(`the sweep's own cutoff (${dry.cutoff || 'unreadable'}) is later than the 12-month floor (${floorCutoff})`);
    }
    const young: string[] = [];
    const unprovable: string[] = [];
    for (const r of dry.rows) {
      const ms = parseStoredInstant(r.created_at);
      if (!Number.isFinite(ms)) unprovable.push(`${r.store}:${r.id} (created_at "${String(r.created_at)}")`);
      else if (ms > floorMs) young.push(`${r.store}:${r.id} (created ${String(r.created_at)})`);
    }
    if (young.length) problems.push(`${young.length} candidate image(s) are younger than 12 months: ${young.slice(0, 5).join(', ')}`);
    if (unprovable.length) problems.push(`${unprovable.length} candidate image(s) have no provable age: ${unprovable.slice(0, 5).join(', ')}`);
    if (problems.length) {
      res.outcome = 'refused';
      res.detail = `Refused by the scheduler guard — ${problems.join('; ')}. Nothing was dropped.`;
      res.retention_run_id = writeRefusalRow(db, {
        cutoff: dry.cutoff || floorCutoff, months: configured, scanned: dry.candidates, detail: res.detail,
      });
      console.error(`[fssai-jobs] retention ${res.detail}`);
      return res;
    }
    const checked = new Set(dry.rows.map((r) => `${r.store}:${r.id}`));

    // (5) Same `now`, same `months` — therefore the same cutoff and the same SELECT.
    // The high-water rowid lets the catch below find the sweep's own row if the
    // sweep throws (it marks that row 'failed' itself) instead of writing a second.
    rowidBefore = Number((db.prepare(`SELECT IFNULL(MAX(rowid), 0) AS m FROM fssai_retention_runs`).get() as any)?.m) || 0;
    const rep = sweepFssaiPhotoRetention(db, {
      now, months: configured, actor: { email: '', name: 'scheduler' },
    });
    res.dropped = rep.dropped;
    res.bytes_freed = rep.bytes_freed;
    res.candidates = rep.candidates;
    res.still_held = rep.still_held;
    res.outcome = 'swept';

    // A row inserted by another process between the dry run and the sweep would
    // have bypassed step 4. Synchronous code makes that window tiny; it is still
    // reported rather than assumed away.
    const unchecked = rep.rows.filter((r) => !checked.has(`${r.store}:${r.id}`)).map((r) => `${r.store}:${r.id}`);

    let runId = rep.retention_run_id;
    const stored = runId
      ? db.prepare(`SELECT status FROM fssai_retention_runs WHERE id = ?`).get(runId) as any
      : null;
    if (!stored) {
      runId = generateId();
      try {
        db.prepare(
          `INSERT INTO fssai_retention_runs
             (id, finished_at, cutoff_date, months_kept, scanned_count, dropped_count, bytes_freed,
              evidence_dropped, attachments_dropped, status, detail, triggered_by)
           VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, 'done', ?, 'scheduler')`,
        ).run(
          runId, rep.cutoff, configured, rep.candidates, rep.dropped, rep.bytes_freed,
          rep.evidence_dropped, rep.attachments_dropped,
          "The sweep's own proof row could not be written; this row was written by the scheduler after it ran.",
        );
      } catch (e: any) {
        runId = '';
        console.error(`[fssai-jobs] retention SWEPT ${rep.dropped} image(s) and NO proof row could be written:`, e?.message);
      }
    }
    res.retention_run_id = runId;

    // (6)
    const stamp = `Scheduler guard: a dry run named ${dry.candidates} image(s), every one created at or before the 12-month floor ${floorCutoff}.`
      + (unchecked.length ? ` WARNING: ${unchecked.length} image(s) appeared after the dry run and were swept unchecked: ${unchecked.slice(0, 5).join(', ')}.` : '');
    if (runId) {
      try {
        db.prepare(
          `UPDATE fssai_retention_runs
              SET detail = CASE WHEN detail = '' THEN ? ELSE detail || ' · ' || ? END
            WHERE id = ?`,
        ).run(stamp, stamp, runId);
      } catch (e: any) {
        console.error('[fssai-jobs] could not stamp the retention row:', e?.message);
      }
    }
    if (unchecked.length) console.error(`[fssai-jobs] retention ${stamp}`);
    res.detail = `${rep.dropped} image(s) dropped (${rep.bytes_freed_label}), ${rep.still_held} still inside the window.`
      + (rep.stores_skipped ? ` Could not walk: ${rep.stores_skipped}.` : '');
    return res;
  } catch (e: any) {
    // The sweep marks its own row 'failed' when its transaction throws; this
    // covers a throw anywhere else (the dry run, the guard) so the day still has a row.
    res.outcome = 'failed';
    res.detail = `The scheduled retention pass failed: ${e?.message || e}`;
    if (!res.retention_run_id && rowidBefore >= 0) {
      try {
        const own = db.prepare(
          `SELECT id FROM fssai_retention_runs WHERE rowid > ? ORDER BY rowid DESC LIMIT 1`,
        ).get(rowidBefore) as any;
        if (own?.id) res.retention_run_id = String(own.id);
      } catch { /* fall through to writing one */ }
    }
    if (!res.retention_run_id) {
      res.retention_run_id = writeRefusalRow(db, { cutoff: floorCutoff, months: configured, scanned: res.candidates, detail: res.detail });
    }
    console.error(`[fssai-jobs] ${res.detail}`);
    return res;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. MISSED-CHECK REMINDERS
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Evaluated from 06:00 IST, for YESTERDAY (a closed business day): late closing
 * checks filed after midnight against yesterday's date are in by then, so the
 * reminder does not accuse anybody of a check they finished at 00:40.
 */
const MISSED_EARLIEST_IST_HOUR = 6;

/** Several runs inside one day — the slot's next DATE is simply the next day. */
const DAY_SHAPED: readonly FssaiFrequency[] = ['hourly', 'per_shift', 'twice_daily', 'daily'];

export interface FssaiMissedCheck {
  assignment_id: string;
  template_id: string;
  template_name: string;
  target_label: string;
  shift: string;
  frequency: string;
  department_id: string;
  department_name: string;
  /** The due period that closed on the business date, inclusive. */
  period_from: string;
  period_to: string;
  recipients: string[];
}

export type FssaiMissedCheckOutcome =
  | 'not_due' | 'already_done' | 'disabled' | 'none_missed' | 'reminded' | 'claimed_elsewhere' | 'failed';

export interface FssaiMissedCheckResult {
  outcome: FssaiMissedCheckOutcome;
  /** The closed business date that was checked. */
  business_date: string;
  scanned: number;
  missed: number;
  people_told: number;
  items: FssaiMissedCheck[];
  detail: string;
}

/**
 * The due period of an assignment that CLOSES on business date `y`, or null.
 *
 * Due dates are the anchor (next_due_date, which nothing advances — it is the
 * schedule's start) and every fssaiNextDueDate step after it: the module's one
 * calendar implementation, so a weekly check's period here is the same week the
 * assignment screen promises. A period [d_k, d_{k+1} - 1] closes on y when
 * d_{k+1} is the day after y. Day-shaped frequencies close every day.
 */
function periodClosingOn(a: any, anchor: string, y: string): { from: string; to: string } | null {
  if (!isISODate(anchor) || anchor > y) return null;
  const freq = String(a.frequency || '');
  if (!isFssaiFrequency(freq) || freq === 'on_event') return null;
  if (DAY_SHAPED.includes(freq)) return { from: y, to: y };
  const dow = Number.isFinite(Number(a.day_of_week)) ? Number(a.day_of_week) : undefined;
  const dom = Number.isFinite(Number(a.day_of_month)) ? Number(a.day_of_month) : undefined;
  let cur = anchor;
  for (let i = 0; i < 2000; i++) {
    const nxt = fssaiNextDueDate(freq, cur, dow, dom);
    if (!isISODate(nxt) || nxt <= cur) return null;     // the calendar cannot say — stay silent
    if (nxt > y) return nxt === addDaysISO(y, 1) ? { from: cur, to: y } : null;
    cur = nxt;
  }
  return null;
}

/** IST business date of a stored UTC 'YYYY-MM-DD HH:MM:SS'. '' if unreadable. */
function istDateOfStored(v: unknown): string {
  const ms = parseStoredInstant(v);
  return Number.isFinite(ms) ? fssaiToday(new Date(ms)) : '';
}

/**
 * Who hears that a check was missed — the most specific answer that exists:
 *   the person it is assigned to → holders of its responsible role (in its
 *   department first) → its department's heads → the management tier.
 * Read-only against users/roles; never writes them. Inactive users never hear.
 */
function missedCheckRecipients(db: Db, a: any): string[] {
  const norm = (rows: any[]) => [...new Set(rows.map((r) => String(r.email || '').trim().toLowerCase()).filter(Boolean))];
  try {
    const assignee = String(a.assignee_email || '').trim();
    if (assignee) {
      const ok = db.prepare(`SELECT email FROM users WHERE lower(email) = lower(?) AND is_active = 1`).all(assignee) as any[];
      if (ok.length) return norm(ok);
    }
    const dept = String(a.department_id || '').trim();
    const roleId = String(a.responsible_role_id || '').trim();
    if (roleId) {
      const inDept = dept
        ? db.prepare(`SELECT email FROM users WHERE is_active = 1 AND role_id = ? AND department_id = ?`).all(roleId, dept) as any[]
        : [];
      const rows = inDept.length ? inDept : db.prepare(`SELECT email FROM users WHERE is_active = 1 AND role_id = ?`).all(roleId) as any[];
      if (rows.length) return norm(rows);
    }
    if (dept) {
      const heads = db.prepare(
        `SELECT DISTINCT u.email FROM users u LEFT JOIN roles r ON r.id = u.role_id
          WHERE u.is_active = 1 AND u.department_id = ?
            AND (u.is_head_chef = 1 OR IFNULL(r.is_head_chef, 0) = 1)`,
      ).all(dept) as any[];
      if (heads.length) return norm(heads);
    }
    const mgmt = db.prepare(
      `SELECT DISTINCT u.email FROM users u LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.is_active = 1
          AND (lower(IFNULL(u.role,'')) IN ('manager','admin') OR lower(IFNULL(r.base_role,'')) IN ('manager','admin'))`,
    ).all() as any[];
    return norm(mgmt);
  } catch (e: any) {
    console.error('[fssai-jobs] could not resolve missed-check recipients:', e?.message);
    return [];
  }
}

/**
 * TELL PEOPLE ABOUT YESTERDAY'S CHECKS THAT WERE NEVER RECORDED. Once per day.
 *
 * MISSED means: an active assignment on a PUBLISHED, active template (the runner
 * refuses anything else, so nobody is nagged about a sheet they cannot open),
 * whose due period closed yesterday, with NO submitted or verified run for its
 * slot — (template_id, target_id, shift), the slot rule the dashboard and
 * uq_fssai_runs_open use — anywhere in that period. A voided or half-filled run
 * does not close a slot, exactly as on the dashboard.
 *
 * DELIBERATELY CONSERVATIVE: an hourly or twice-a-day check counts as missed
 * only when NOTHING was filed for it that day. It can under-report; it cannot
 * accuse somebody who filed. An assignment created after yesterday is never
 * reported, and nothing before yesterday is ever back-filled.
 *
 * ONE MESSAGE PER PERSON PER DAY listing their checks, not one per check: a
 * kitchen with forty schedules must not wake up to forty pings. The day is
 * claimed once on notifications' UNIQUE (party_unique_id, kind, channel), so two
 * workers cannot both send. Every missed check also leaves an fssai_audit_log
 * row, so §19 can tell "nobody was told" from "everybody was told".
 *
 * Off when the Chasing panel's master switch (fssai_esc_enabled) is off — that
 * switch is documented as "nothing is sent at all".
 */
export function runFssaiMissedCheckReminders(db: Db, opts: { now?: Date } = {}): FssaiMissedCheckResult {
  const now = opts.now ?? new Date();
  const today = fssaiToday(now);
  const y = addDaysISO(today, -1);
  const res: FssaiMissedCheckResult = {
    outcome: 'not_due', business_date: y, scanned: 0, missed: 0, people_told: 0, items: [], detail: '',
  };
  if (istHourOf(now) < MISSED_EARLIEST_IST_HOUR) {
    res.detail = `Runs from ${MISSED_EARLIEST_IST_HOUR}:00 IST for the previous day.`;
    return res;
  }
  if (getSetting(db, KEY_MISSED_DAY) === y) {
    res.outcome = 'already_done';
    return res;
  }
  try {
    if (!readFssaiEscalationRules(db).enabled) {
      res.outcome = 'disabled';
      res.detail = 'Chasing is switched off on the Chasing panel.';
      return res;
    }
    if (!tableExists(db, 'fssai_assignments') || !tableExists(db, 'fssai_runs')) {
      res.outcome = 'failed';
      res.detail = 'fssai_assignments / fssai_runs are not in this database.';
      return res;
    }

    const rows = db.prepare(
      `SELECT a.id, a.template_id, a.department_id, a.assignee_email, a.responsible_role_id,
              a.target_id, a.target_label, a.shift, a.frequency, a.day_of_week, a.day_of_month,
              a.next_due_date, a.outlet_id, a.created_at,
              t.name AS template_name, IFNULL(d.name, '') AS department_name
         FROM fssai_assignments a
         JOIN fssai_templates t ON t.id = a.template_id
         LEFT JOIN departments d ON d.id = a.department_id
        WHERE a.is_active = 1 AND a.frequency <> 'on_event'
          AND t.is_active = 1 AND t.status = 'published'
        ORDER BY t.name ASC, a.target_label ASC, a.shift ASC`,
    ).all() as any[];
    res.scanned = rows.length;

    const filed = db.prepare(
      `SELECT 1 FROM fssai_runs
        WHERE template_id = ? AND IFNULL(target_id,'') = ? AND IFNULL(shift,'') = ?
          AND business_date BETWEEN ? AND ?
          AND status IN ('submitted','verified')
        LIMIT 1`,
    );

    const outletOf = new Map<string, string>();
    for (const a of rows) {
      const createdIst = istDateOfStored(a.created_at);
      if (!createdIst || createdIst > y) continue;               // did not exist yesterday
      const anchor = isISODate(a.next_due_date) ? String(a.next_due_date) : createdIst;
      const period = periodClosingOn(a, anchor, y);
      if (!period) continue;
      if (filed.get(String(a.template_id), String(a.target_id || ''), String(a.shift || ''), period.from, period.to)) continue;
      res.items.push({
        assignment_id: String(a.id),
        template_id: String(a.template_id),
        template_name: String(a.template_name || ''),
        target_label: String(a.target_label || ''),
        shift: String(a.shift || ''),
        frequency: String(a.frequency || ''),
        department_id: String(a.department_id || ''),
        department_name: String(a.department_name || ''),
        period_from: period.from,
        period_to: period.to,
        recipients: missedCheckRecipients(db, a),
      });
      outletOf.set(String(a.id), String(a.outlet_id || ''));
    }
    res.missed = res.items.length;

    if (!res.items.length) {
      res.outcome = 'none_missed';
      setSetting(db, KEY_MISSED_DAY, y);
      return res;
    }

    // One list per person.
    const perPerson = new Map<string, FssaiMissedCheck[]>();
    for (const it of res.items) {
      for (const p of it.recipients) {
        const list = perPerson.get(p) || [];
        list.push(it);
        perPerson.set(p, list);
      }
    }
    const everyone = [...perPerson.keys()];
    const label = (it: FssaiMissedCheck) =>
      [it.template_name, it.target_label, it.shift].filter(Boolean).join(' · ')
      + (it.period_from !== it.period_to ? ` (due ${it.period_from}–${it.period_to})` : '');
    const title = (n: number) => `${n} food-safety check${n === 1 ? ' was' : 's were'} not recorded on ${y}`;
    const body = (list: FssaiMissedCheck[]) => {
      const shown = list.slice(0, 8).map(label);
      const more = list.length > shown.length ? ` … and ${list.length - shown.length} more` : '';
      return `${shown.join('; ')}${more}. Nothing was filed for ${list.length === 1 ? 'it' : 'them'}; record it late with a reason, or tell your manager why it did not happen.`;
    };

    let won = false;
    const tx = db.transaction(() => {
      const claim = db.prepare(
        `INSERT OR IGNORE INTO notifications
           (id, kind, party_unique_id, fp_id, event_name, event_date, channel, recipient, title, body)
         VALUES (?, 'fssai_checks_missed', ?, NULL, 'FSSAI checks not recorded', ?, 'inapp', ?, ?, ?)`,
      ).run(generateId(), `fssai-missed:${y}`, y, everyone.join(','), title(res.items.length), body(res.items));
      if (claim.changes === 0) return;          // another worker already said it
      won = true;
      const tell = db.prepare(
        `INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href)
         VALUES (?, ?, 'fssai_check_missed', ?, ?, '', '/fssai/checklists/run')`,
      );
      for (const [email, list] of perPerson) {
        tell.run(generateId(), email, title(list.length), body(list));
        res.people_told += 1;
      }
      for (const it of res.items) {
        fssaiAuditBestEffort(db, {
          entity_table: 'fssai_assignments', entity_id: it.assignment_id,
          action: 'remind_missed', field: 'business_date',
          after: {
            business_date: y, period_from: it.period_from, period_to: it.period_to,
            template_id: it.template_id, template_name: it.template_name,
            target_label: it.target_label, shift: it.shift, recipients: it.recipients,
          },
          reason: `No submitted record for this check between ${it.period_from} and ${it.period_to}.`,
          actor: { email: 'system', name: 'Missed-check reminder' },
          outlet_id: outletOf.get(it.assignment_id) || '',
        });
      }
    });
    tx();
    setSetting(db, KEY_MISSED_DAY, y);

    if (!won) {
      res.outcome = 'claimed_elsewhere';
      res.people_told = 0;
      return res;
    }
    res.outcome = 'reminded';
    res.detail = `${res.missed} check(s) missed on ${y}; ${res.people_told} person(s) told.`;

    // Push AFTER the commit, fire-and-forget: a push failure can never reach the tick.
    for (const [email, list] of perPerson) {
      Promise.resolve()
        .then(() => sendPushToUser(db, email, { title: title(list.length), body: body(list), url: '/fssai/checklists/run' }))
        .catch(() => { /* never */ });
    }
    return res;
  } catch (e: any) {
    res.outcome = 'failed';
    res.detail = `Missed-check reminders failed: ${e?.message || e}`;
    console.error(`[fssai-jobs] ${res.detail}`);
    return res;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE TICK
 * ════════════════════════════════════════════════════════════════════════ */

export interface FssaiJobsReport {
  at: string;
  escalation: FssaiEscalationJobResult | { error: string };
  retention: FssaiRetentionJobResult | { error: string };
  missed_checks: FssaiMissedCheckResult | { error: string };
}

/**
 * Everything FSSAI does unattended, once per scheduler tick. Each job is in its
 * own try, so one failing cannot starve the other two. Ends by stamping a
 * heartbeat (settings.fssai_job_heartbeat) that a screen can read to say the
 * driver is ALIVE on evidence — readFssaiJobsHeartbeat below.
 */
export async function runFssaiScheduledJobs(db: Db, opts: { now?: Date } = {}): Promise<FssaiJobsReport> {
  const now = opts.now ?? new Date();
  const report: FssaiJobsReport = {
    at: now.toISOString(),
    escalation: { error: 'not run' },
    retention: { error: 'not run' },
    missed_checks: { error: 'not run' },
  };
  try { report.escalation = await runFssaiEscalationJob(db); } catch (e: any) { report.escalation = { error: String(e?.message || e) }; }
  try { report.retention = runFssaiRetentionJob(db, { now }); } catch (e: any) { report.retention = { error: String(e?.message || e) }; }
  try { report.missed_checks = runFssaiMissedCheckReminders(db, { now }); } catch (e: any) { report.missed_checks = { error: String(e?.message || e) }; }

  try {
    const esc: any = report.escalation;
    const ret: any = report.retention;
    const mis: any = report.missed_checks;
    setSetting(db, KEY_HEARTBEAT, JSON.stringify({
      at: report.at,
      escalation: esc.error ? { error: esc.error } : {
        ran: !!esc.sweep?.ran, skipped: esc.sweep?.skipped || '', people_told: esc.sweep?.people_told || 0,
        errors: (esc.sweep?.errors || []).length + (esc.slack_errors || []).length,
      },
      retention: ret.error ? { error: ret.error } : {
        outcome: ret.outcome, day: ret.day, dropped: ret.dropped, retention_run_id: ret.retention_run_id,
      },
      missed_checks: mis.error ? { error: mis.error } : {
        outcome: mis.outcome, business_date: mis.business_date, missed: mis.missed, people_told: mis.people_told,
      },
    }));
  } catch (e: any) {
    console.error('[fssai-jobs] heartbeat could not be written:', e?.message);
  }
  return report;
}

/** The last tick's summary, or null if the scheduler has never run these jobs on this database. */
export function readFssaiJobsHeartbeat(db: Db): { at: string; [k: string]: unknown } | null {
  const raw = getSetting(db, KEY_HEARTBEAT);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && typeof v.at === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * One log line for the scheduler, or null when nothing worth a line happened —
 * the throttled / not-due answers are the overwhelmingly common ones and would
 * otherwise print every five minutes.
 */
export function fssaiJobsLogLine(r: FssaiJobsReport): string | null {
  const parts: string[] = [];
  const esc: any = r.escalation;
  if (esc.error) parts.push(`chase ERROR ${esc.error}`);
  else {
    if (esc.sweep?.people_told > 0) parts.push(`chase told ${esc.sweep.people_told}`);
    const errs = (esc.sweep?.errors || []).length + (esc.slack_errors || []).length;
    if (errs) parts.push(`chase ${errs} error(s)`);
    if (esc.slack_sent > 0) parts.push(`slack ${esc.slack_sent}`);
  }
  const ret: any = r.retention;
  if (ret.error) parts.push(`retention ERROR ${ret.error}`);
  else if (!['not_due', 'already_ran_today'].includes(ret.outcome)) parts.push(`retention ${ret.outcome}: ${ret.detail}`);
  const mis: any = r.missed_checks;
  if (mis.error) parts.push(`missed-checks ERROR ${mis.error}`);
  else if (['reminded', 'failed'].includes(mis.outcome)) parts.push(`missed-checks ${mis.outcome}: ${mis.detail}`);
  return parts.length ? parts.join(' · ') : null;
}
