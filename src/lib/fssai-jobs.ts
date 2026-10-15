/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FSSAI — THE UNATTENDED JOBS, AND THE ONLY THING THAT DRIVES THEM.
 *
 * ═══ 2026-10-14 — THE OWNER'S RULINGS, AND WHAT THIS FILE NOW ADDS ═══════════
 *
 *   4. MISSED CHECKS ALSO GO TO WHATSAPP — runFssaiMissedCheckWhatsApp. "Keep
 *      the next-morning bell AND add WhatsApp to the SAME recipients." Same
 *      people missedCheckRecipients() resolves, each mapped to a number the app
 *      ALREADY holds (users.wa_mobile, else hr_employees.phone10 — the
 *      wa-report-recipients resolver, not a second one). Approved TEMPLATE only,
 *      through sendWhatsAppTemplate — free text is never sent. DORMANT (bell
 *      only) until the template is approved AND the Meta app secret exists; a
 *      dormant day is still written down, one fssai_job_notices row per person,
 *      so "nobody was told" and "we hold no number for them" are different rows.
 *      Nothing here configures WhatsApp or writes a credential.
 *
 *   5. AN ABANDONED OR OVERDUE COOLING — OR REHEATING — BATCH IS ESCALATED —
 *      runFssaiCoolingOverdueJob / runFssaiReheatingOverdueJob (one engine,
 *      runFssaiCurveOverdueJob; job keys 'cooling_overdue' / 'reheating_overdue').
 *      A batch whose time limit has passed with no reading at the target used to
 *      sit as "overdue" on a screen nobody opened. Now, once the window plus a
 *      short grace has passed, it raises ONE corrective action and rings the
 *      bell of the people who recorded it and their department's head — claimed
 *      once per batch on fssai_job_notices' UNIQUE index. A batch whose first
 *      reading at the target came AFTER the time allowed is raised too
 *      (2026-10-15: it used to count as reached). Reheating had no job at all
 *      until 2026-10-15.
 *
 *   6. OWNER RULING Q19 — applyFssaiOwnerRulings. The leftover test checklist
 *      ZZ-P2B-COLDROOM is deleted from any database this app runs on, only while
 *      it is still the empty draft it was (no questions, sections, assignments
 *      or rounds), with an fssai_audit_log row. Nothing in this codebase seeds it.
 *
 *   Q22 (attachments are never auto-deleted) is enforced in fssai-retention.ts
 *   and BACKSTOPPED in the retention guard below: a dry run that names any
 *   store other than fssai_evidence refuses the whole pass.
 *
 *   7. FOR THE AUDIT FILE AND INSPECTION MODE — fssaiJobsAuditSummary(db,
 *      { since, until }). Read-only, never throws: is the driver alive (heartbeat
 *      age), each day's missed checks with who the bell rang and what WhatsApp
 *      did per person, every abandoned cooling batch raised with its action
 *      number and status, the Q22 ruling verbatim with the stores the sweep
 *      walks / never walks and its last run, and whether the Q19 leftover is
 *      gone. A screen or the PDF calls this; it does not re-derive any of it.
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
 *      about to drop is at least twelve months old AND a checklist photograph
 *      (Q22: attachments never), and that makes sure every scheduled pass —
 *      swept, refused or failed — leaves an fssai_retention_runs row.
 *
 *   3. MISSED-CHECK REMINDERS — there was NO existing function for this
 *      (FSSAI-BUILD-STATE.md, P3 row: "any due/overdue reminder" not built), so
 *      it is the one piece of logic this file owns. It reads the SAME slot rule
 *      the dashboard and the runner use and the module's single calendar
 *      implementation (fssaiNextDueDate); it writes notifications, never a
 *      record. See runFssaiMissedCheckReminders.
 *
 * WHAT THIS FILE NEVER DOES: write fssai_runs, fssai_responses, an assignment,
 * a department, a role or a mapping, or change a filed reading. Its writes are
 * `notifications` (the claim), `task_notifications` (the bell),
 * `fssai_audit_log` (the trail), `fssai_retention_runs` (the proof — and only
 * for a refusal or a lost proof row; a real sweep writes its own),
 * `fssai_job_notices` (who was told what, on which channel — and who could
 * not be), `fssai_corrective_actions` (ONLY the one action an overdue cooling
 * batch raises), the ONE template delete Q19 ordered, and `settings` keys under
 * `fssai_job_*` (once-a-day watermarks + a heartbeat).
 *
 * better-sqlite3 IS SYNCHRONOUS: every db.transaction() below is a plain
 * synchronous function. The `await`s in this file — the Slack flush and the
 * WhatsApp template sends — are outside every transaction.
 */
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
import {
  FSSAI_PHOTO_RETENTION_MONTHS, fssaiToday, addDaysISO, isISODate, fssaiNextDueDate,
  isFssaiFrequency, fssaiCaDueDate, type FssaiFrequency,
} from '@/lib/fssai';
import {
  sweepFssaiPhotoRetention, FSSAI_RETENTION_SWEPT_STORES, FSSAI_RETENTION_NEVER_SWEPT_STORES,
  FSSAI_Q22_RULING, listFssaiRetentionRuns,
} from '@/lib/fssai-retention';
import {
  sweepFssaiCaAlerts, flushFssaiAlertSlack, readFssaiEscalationRules, type FssaiSweepResult,
} from '@/lib/fssai-alerts';
import { fssaiAudit, fssaiAuditBestEffort, nextFssaiCaNumber } from '@/lib/fssai-server';
import { sendPushToUser } from '@/lib/push';
import { isWaConfigured, sendWhatsAppTemplate } from '@/lib/whatsapp';
import { templateSendability, webhookAppSecretLookup } from '@/lib/wa-template-authoring';
import { numberForUser } from '@/lib/wa-report-recipients';
import { fssaiCurveMembers, fssaiCurveReached, fssaiClockMinute } from '@/app/api/fssai/_p4/lib';

type Db = Database.Database;

/* ══════════════════════════════════════════════════════════════════════════
 * SHARED PLUMBING
 * ════════════════════════════════════════════════════════════════════════ */

/** IST hour (0-23) of an instant, independent of the host timezone (fssaiToday's own +5.5h rule). */
function istHourOf(now: Date): number {
  return new Date(now.getTime() + 5.5 * 3600_000).getUTCHours();
}

/** IST 'HH:MM' of an instant — the clock a temperature reading's reading_at is on. */
function istHHMMOf(now: Date): string {
  const d = new Date(now.getTime() + 5.5 * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** Lower-cased, trimmed, de-duplicated, empties dropped — the one email key. */
function normEmails(rows: any[]): string[] {
  return [...new Set(rows.map((r) => String(r?.email || '').trim().toLowerCase()).filter(Boolean))];
}

/** Active heads of a department (is_head_chef on the user OR on their role). Read-only. */
function departmentHeads(db: Db, dept: string): string[] {
  if (!dept) return [];
  return normEmails(db.prepare(
    `SELECT DISTINCT u.email FROM users u LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.is_active = 1 AND u.department_id = ?
        AND (u.is_head_chef = 1 OR IFNULL(r.is_head_chef, 0) = 1)`,
  ).all(dept) as any[]);
}

/** Active management tier (manager / admin, by the user's role or its base role). Read-only. */
function managementTier(db: Db): string[] {
  return normEmails(db.prepare(
    `SELECT DISTINCT u.email FROM users u LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.is_active = 1
        AND (lower(IFNULL(u.role,'')) IN ('manager','admin') OR lower(IFNULL(r.base_role,'')) IN ('manager','admin'))`,
  ).all() as any[]);
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
    const wrongStore: string[] = [];
    for (const r of dry.rows) {
      // OWNER RULING Q22 (2026-10-14): document scans in fssai_attachments are
      // NEVER auto-deleted; only checklist photographs (fssai_evidence) age out.
      // fssai-retention.ts already walks fssai_evidence alone — this is the
      // backstop for the day somebody widens that list: a dry run that names ANY
      // other store refuses the whole pass, before a single image is touched.
      if (String(r.store) !== 'fssai_evidence') {
        wrongStore.push(`${r.store}:${r.id}`);
        continue;
      }
      const ms = parseStoredInstant(r.created_at);
      if (!Number.isFinite(ms)) unprovable.push(`${r.store}:${r.id} (created_at "${String(r.created_at)}")`);
      else if (ms > floorMs) young.push(`${r.store}:${r.id} (created ${String(r.created_at)})`);
    }
    const sweptStores = [...FSSAI_RETENTION_SWEPT_STORES].map(String);
    if (sweptStores.some((s) => s !== 'fssai_evidence')) {
      problems.push(`the sweep is configured to walk ${sweptStores.join(', ')}, but the owner ruled (Q22, 2026-10-14) that only checklist photographs (fssai_evidence) may age out — register files are never deleted automatically`);
    }
    if (wrongStore.length) problems.push(`${wrongStore.length} candidate(s) are not checklist photographs, and Q22 says those are never auto-deleted: ${wrongStore.slice(0, 5).join(', ')}`);
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
  /**
   * ONE ENTRY PER PERSON, with the checks their message lists — the exact
   * grouping the bell used. runFssaiMissedCheckWhatsApp sends from this and
   * nothing else, so the WhatsApp leg cannot reach a different set of people
   * than the bell did. Filled whenever something was missed.
   */
  people: { email: string; assignment_ids: string[] }[];
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
  try {
    const assignee = String(a.assignee_email || '').trim();
    if (assignee) {
      const ok = db.prepare(`SELECT email FROM users WHERE lower(email) = lower(?) AND is_active = 1`).all(assignee) as any[];
      if (ok.length) return normEmails(ok);
    }
    const dept = String(a.department_id || '').trim();
    const roleId = String(a.responsible_role_id || '').trim();
    if (roleId) {
      const inDept = dept
        ? db.prepare(`SELECT email FROM users WHERE is_active = 1 AND role_id = ? AND department_id = ?`).all(roleId, dept) as any[]
        : [];
      const rows = inDept.length ? inDept : db.prepare(`SELECT email FROM users WHERE is_active = 1 AND role_id = ?`).all(roleId) as any[];
      if (rows.length) return normEmails(rows);
    }
    const heads = departmentHeads(db, dept);
    if (heads.length) return heads;
    return managementTier(db);
  } catch (e: any) {
    console.error('[fssai-jobs] could not resolve missed-check recipients:', e?.message);
    return [];
  }
}

/** One missed check in words — the bell and the WhatsApp list say it identically. */
function fssaiMissedCheckLabel(it: FssaiMissedCheck): string {
  return [it.template_name, it.target_label, it.shift].filter(Boolean).join(' · ')
    + (it.period_from !== it.period_to ? ` (due ${it.period_from}–${it.period_to})` : '');
}

/**
 * TELL PEOPLE ABOUT YESTERDAY'S CHECKS THAT WERE NEVER RECORDED. Once per day.
 *
 * THIS IS THE BELL. The WhatsApp leg the owner added on 2026-10-14 is
 * runFssaiMissedCheckWhatsApp, which the tick calls straight after this with
 * this result — to the same people, with the same lists (`people`). It is a
 * separate function only because a send is async and this is not.
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
    outcome: 'not_due', business_date: y, scanned: 0, missed: 0, people_told: 0, items: [], people: [], detail: '',
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
    res.people = everyone.map((email) => ({
      email, assignment_ids: (perPerson.get(email) || []).map((it) => it.assignment_id),
    }));
    const label = fssaiMissedCheckLabel;
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
 * 3b. MISSED CHECKS ON WHATSAPP — owner ruling 2026-10-14
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * THE TEMPLATE THE OWNER SUBMITS. The app never creates or submits it — it is
 * authored in Settings → Integrations → WhatsApp → Templates and approved by
 * Meta. Until a row of this name is APPROVED, this leg is dormant.
 *
 * Suggested body (category UTILITY — our own staff, about our own operation):
 *
 *   Food-safety checks not recorded on {{1}}: {{2}} check(s) — {{3}}. Please
 *   record them late with a reason in F&B Controller, or tell your manager why
 *   they did not happen.
 *
 * It starts and ends with text and no two variables touch — the two rules that
 * cause most rejections (docs/interakt-templates.md).
 */
export const FSSAI_MISSED_WA_TEMPLATE = 'fssai_checks_missed';
export const FSSAI_MISSED_WA_LANG = 'en';
/** {{1}}, {{2}}, {{3}} — the positional contract, in WA_EVENT_PARAM_ORDER style. */
export const FSSAI_MISSED_WA_PARAM_ORDER = ['business_date', 'count', 'checks'] as const;

export type FssaiJobSkipReason = '' | 'no_phone' | 'no_template' | 'no_app_secret' | 'disabled' | 'provider_error';

export interface FssaiMissedWaReadiness {
  /** May a message be sent right now? */
  ready: boolean;
  /** The FIRST blocker, in the ruling's order: template, app secret, then the connection. '' when ready. */
  skip_reason: FssaiJobSkipReason;
  template_name: string;
  template_lang: string;
  /** whatsapp_templates.meta_status, lower-cased; '' when no row. */
  template_status: string;
  template_ok: boolean;
  app_secret_present: boolean;
  /** Could the secret's PRESENCE be read? A failed read is never "no secret is set, so carry on". */
  app_secret_unreadable: boolean;
  connected: boolean;
  /** Every blocker, in words, for a screen. */
  blockers: string[];
}

/**
 * IS THE WHATSAPP LEG ALLOWED TO SEND? Three facts, all required, read fresh:
 *
 *  1. THE TEMPLATE IS APPROVED — a whatsapp_templates row of this name whose
 *     meta_status is 'approved', AND templateSendability agrees (so a paused,
 *     rejected or wrong-language row still fails). Approval is read off the ROW
 *     because templateSendability alone says ok for a name nobody has heard of
 *     (its "unmanaged local template" branch) — the trap boh-notify.ts measured.
 *  2. THE META APP SECRET EXISTS — env or settings, via the webhook's own lookup
 *     (webhookAppSecretLookup). Only its PRESENCE is read; the value never
 *     leaves that function's caller here, never reaches a log, a row or a reply.
 *     A secret whose presence could not be read counts as absent.
 *  3. WHATSAPP IS CONNECTED — isWaConfigured(), the send path's own test.
 *
 * Pure reads. Writes nothing, sends nothing, configures nothing.
 */
export function fssaiMissedCheckWaReadiness(db: Db): FssaiMissedWaReadiness {
  const out: FssaiMissedWaReadiness = {
    ready: false, skip_reason: '', template_name: FSSAI_MISSED_WA_TEMPLATE, template_lang: FSSAI_MISSED_WA_LANG,
    template_status: '', template_ok: false, app_secret_present: false, app_secret_unreadable: false,
    connected: false, blockers: [],
  };
  // 1. the template
  try {
    let row: any;
    try { row = db.prepare(`SELECT name, meta_status FROM whatsapp_templates WHERE name = ?`).get(FSSAI_MISSED_WA_TEMPLATE); }
    catch { row = undefined; }
    out.template_status = String(row?.meta_status || '').trim().toLowerCase();
    const approved = !!row && out.template_status === 'approved';
    const s = approved ? templateSendability(db, FSSAI_MISSED_WA_TEMPLATE, FSSAI_MISSED_WA_LANG) : null;
    out.template_ok = approved && !!s?.ok;
    if (!out.template_ok) {
      out.blockers.push(
        !row
          ? `No WhatsApp template named "${FSSAI_MISSED_WA_TEMPLATE}" exists yet. Author and submit it from Settings → Integrations → WhatsApp → Templates; until Meta approves it, missed checks go to the bell only.`
          : !approved
            ? `The WhatsApp template "${FSSAI_MISSED_WA_TEMPLATE}" is ${out.template_status ? `"${out.template_status}" at Meta` : 'not yet submitted to Meta'}, not approved. Missed checks go to the bell only until it is.`
            : `The WhatsApp template "${FSSAI_MISSED_WA_TEMPLATE}" is approved but cannot be sent: ${String((s as any)?.advisory || s?.reason || 'the template lifecycle refused it')}`,
      );
    }
  } catch {
    out.template_ok = false;
    out.blockers.push('The WhatsApp template list could not be read, so no template can be proved approved. Missed checks go to the bell only.');
  }
  // 2. the app secret — presence only
  try {
    const sec = webhookAppSecretLookup(db);
    out.app_secret_unreadable = !!sec.unreadable;
    out.app_secret_present = !sec.unreadable && !!String(sec.secret || '').trim();
  } catch {
    out.app_secret_unreadable = true;
    out.app_secret_present = false;
  }
  if (!out.app_secret_present) {
    out.blockers.push(out.app_secret_unreadable
      ? 'Whether the Meta app secret is set could not be read, so WhatsApp stays off for missed checks (bell only).'
      : 'The Meta app secret is not set on this install, so WhatsApp stays off for missed checks (bell only). The owner adds it; the app never does.');
  }
  // 3. the connection
  try { out.connected = isWaConfigured(); } catch { out.connected = false; }
  if (!out.connected) {
    out.blockers.push('WhatsApp is not connected (Settings → Integrations → WhatsApp has no working phone number id and token), so nothing can be sent.');
  }
  out.ready = out.template_ok && out.app_secret_present && out.connected;
  out.skip_reason = out.ready ? ''
    : !out.template_ok ? 'no_template'
      : !out.app_secret_present ? 'no_app_secret'
        : 'disabled';
  return out;
}

/** Where a number for this login would come from, in the contract's words. */
type FssaiPhoneSource = '' | 'users.wa_mobile' | 'hr_employees.phone10';

/**
 * THE NUMBER THE APP ALREADY HOLDS FOR ONE LOGIN — never a number from a
 * request, never a guess. users.wa_mobile first, then the HR record linked to
 * the login (numberForUser in wa-report-recipients.ts — the reports rail's own
 * resolver, so the two rails cannot disagree about a person's number).
 * A value that is not a plausible international mobile (11–15 digits once
 * normalised) is reported as NO number, with what was on file in `bad`.
 */
function fssaiPhoneForEmail(db: Db, email: string): { number: string; source: FssaiPhoneSource; bad: string } {
  let u: any;
  try {
    u = db.prepare(
      `SELECT id, name, email, role, is_head_chef, department_id, COALESCE(wa_mobile, '') AS wa_mobile
         FROM users WHERE lower(email) = lower(?) AND is_active = 1 LIMIT 1`,
    ).get(email);
  } catch {
    try {
      u = db.prepare(
        `SELECT id, name, email, role, is_head_chef, department_id, '' AS wa_mobile
           FROM users WHERE lower(email) = lower(?) AND is_active = 1 LIMIT 1`,
      ).get(email);
    } catch { u = undefined; }
  }
  if (!u) return { number: '', source: '', bad: '' };
  const r = numberForUser(db, u);
  const source: FssaiPhoneSource = r.source === 'wa_mobile' ? 'users.wa_mobile' : r.source === 'hr_phone' ? 'hr_employees.phone10' : '';
  if (!r.number) return { number: '', source: '', bad: '' };
  if (!/^\d{11,15}$/.test(r.number)) return { number: '', source, bad: r.number };
  return { number: r.number, source, bad: '' };
}

/** '…1234' — a number in a log line or a reply is masked; the notices table holds the real one. */
function maskPhone(n: string): string {
  return n ? `…${n.slice(-4)}` : '';
}

/** Meta refuses a body parameter with a newline, a tab or a run of more than four spaces. */
function waParam(v: unknown, max = 700): string {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function humanDate(iso: string): string {
  if (!isISODate(iso)) return iso;
  const [y, m, d] = iso.split('-').map(Number);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  return `${d} ${mon} ${y}`;
}

/** The three body parameters for one person, in FSSAI_MISSED_WA_PARAM_ORDER. */
export function fssaiMissedCheckWaParams(businessDate: string, checks: FssaiMissedCheck[]): string[] {
  const shown = checks.slice(0, 8).map(fssaiMissedCheckLabel);
  const more = checks.length > shown.length ? ` … and ${checks.length - shown.length} more` : '';
  return [
    waParam(humanDate(businessDate), 40),
    String(checks.length),
    waParam(`${shown.join('; ')}${more}`) || '-',
  ];
}

export interface FssaiMissedWaRow {
  email: string;
  status: 'sent' | 'skipped' | 'dormant' | 'failed' | 'already_claimed';
  skip_reason: FssaiJobSkipReason;
  phone_source: FssaiPhoneSource;
  /** Masked. The full number is in fssai_job_notices.recipient_phone. */
  phone: string;
  notice_id: string;
  detail: string;
}

export interface FssaiMissedWaResult {
  outcome: 'not_run' | 'dormant' | 'sent' | 'partial' | 'none_sent' | 'failed';
  business_date: string;
  readiness: Pick<FssaiMissedWaReadiness, 'ready' | 'skip_reason' | 'template_name' | 'template_status' | 'app_secret_present' | 'connected' | 'blockers'>;
  recipients: number;
  sent: number;
  failed: number;
  dormant: number;
  no_phone: number;
  already_claimed: number;
  rows: FssaiMissedWaRow[];
  detail: string;
}

/**
 * THE WHATSAPP LEG OF THE MISSED-CHECK REMINDER. Call it with the result of
 * runFssaiMissedCheckReminders; it acts ONLY when that pass actually rang the
 * bell (`reminded`) — so it reaches exactly the bell's people, once.
 *
 * ONE fssai_job_notices ROW PER PERSON, for every person, whatever happens:
 *   dormant  the template is not approved / the app secret is missing / not
 *            connected (skip_reason says which) — bell only, by ruling;
 *   skipped  ready, but the app holds no usable number for them ('no_phone');
 *   sent     the approved template was accepted by the provider;
 *   failed   the provider refused or the network failed ('provider_error').
 * The row IS the claim (UNIQUE job, subject, channel, recipient — INSERT OR
 * IGNORE, changes === 1 means it is ours), so a second worker or a second run
 * of the same day finds it and sends nothing. EVERY person's row is claimed in
 * one transaction BEFORE the first send; a row about to be sent is claimed as
 * 'failed' with "queued, no answer recorded" and corrected after the provider
 * answers. A crash mid-send therefore leaves an honest row for every person,
 * never a person with no row and never a silent double send.
 *
 * TEMPLATE ONLY. sendWhatsAppTemplate is the only send this calls. There is no
 * free-form fallback — it would not deliver at 06:00 anyway, and the owner
 * ruled it out.
 */
export async function runFssaiMissedCheckWhatsApp(
  db: Db,
  res: FssaiMissedCheckResult,
): Promise<FssaiMissedWaResult> {
  const out: FssaiMissedWaResult = {
    outcome: 'not_run', business_date: res.business_date,
    readiness: {
      ready: false, skip_reason: '', template_name: FSSAI_MISSED_WA_TEMPLATE, template_status: '',
      app_secret_present: false, connected: false, blockers: [],
    },
    recipients: 0, sent: 0, failed: 0, dormant: 0, no_phone: 0, already_claimed: 0, rows: [], detail: '',
  };
  if (res.outcome !== 'reminded' || !res.people.length) {
    out.detail = `Nothing to send: the bell pass was "${res.outcome}".`;
    return out;
  }
  if (!tableExists(db, 'fssai_job_notices')) {
    out.outcome = 'failed';
    out.detail = 'fssai_job_notices is not in this database, so a WhatsApp send could not be claimed or recorded. Nothing was sent.';
    console.error(`[fssai-jobs] missed-checks whatsapp: ${out.detail}`);
    return out;
  }

  const ready = fssaiMissedCheckWaReadiness(db);
  out.readiness = {
    ready: ready.ready, skip_reason: ready.skip_reason, template_name: ready.template_name,
    template_status: ready.template_status, app_secret_present: ready.app_secret_present,
    connected: ready.connected, blockers: ready.blockers,
  };
  const byId = new Map(res.items.map((it) => [it.assignment_id, it]));
  /** The outlet of the first check on a person's list — the notice row's outlet. */
  const outletOf = (ids: string[]): string => {
    if (!ids.length) return '';
    try {
      const r = db.prepare(`SELECT outlet_id FROM fssai_assignments WHERE id = ?`).get(ids[0]) as any;
      return String(r?.outlet_id || '');
    } catch { return ''; }
  };

  const claim = db.prepare(
    `INSERT OR IGNORE INTO fssai_job_notices
       (id, job_key, subject_key, channel, recipient_email, recipient_phone, phone_source,
        template_name, template_lang, status, skip_reason, detail, outlet_id)
     VALUES (?, 'missed_checks', ?, 'whatsapp', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  /* ── DECIDE FOR EVERY PERSON, THEN CLAIM EVERY PERSON — BEFORE ANY SEND ──────
   * The claims are written in ONE synchronous transaction, before the first
   * `await`. The bell pass that produced `res` committed a moment ago in the
   * same synchronous run, so the bell and every person's WhatsApp row are
   * written back to back with no network call between them: a send that hangs
   * or a process that dies mid-send can no longer leave the people after it
   * with no row at all (and the day is already claimed, so nothing would ever
   * write one). A row that is about to be sent is claimed as an honest failure
   * ("queued, no answer recorded") and corrected after the provider answers. */
  type Plan = {
    email: string; checks: FssaiMissedCheck[]; phone: ReturnType<typeof fssaiPhoneForEmail>;
    id: string; outlet: string; status: FssaiMissedWaRow['status']; skip: FssaiJobSkipReason;
    detail: string; usePhone: string; won: boolean;
  };
  const plans: Plan[] = res.people.map((p) => {
    const email = String(p.email || '').trim().toLowerCase();
    const checks = p.assignment_ids.map((aid) => byId.get(aid)).filter(Boolean) as FssaiMissedCheck[];
    const phone = fssaiPhoneForEmail(db, email);
    const plan: Plan = {
      email, checks, phone, id: generateId(), outlet: outletOf(p.assignment_ids),
      status: 'failed', skip: 'provider_error', detail: '', usePhone: '', won: false,
    };
    if (!ready.ready) {
      plan.status = 'dormant';
      plan.skip = ready.skip_reason;
      plan.detail = `Bell only — ${ready.blockers[0] || 'WhatsApp is not ready'}`
        + (phone.number ? ` (a number is on file from ${phone.source})` : ' (and no WhatsApp number is on file for this person)');
    } else if (!phone.number) {
      plan.status = 'skipped';
      plan.skip = 'no_phone';
      plan.detail = phone.bad
        ? `The number on file (${phone.source}) is not a usable WhatsApp number (${maskPhone(phone.bad)}). Correct it on the user record.`
        : 'No WhatsApp number is on file for this person: add it on their user record (WhatsApp mobile), or link them to an HR record with a phone number.';
    } else {
      plan.status = 'failed';
      plan.skip = 'provider_error';
      plan.detail = 'Queued for sending; no answer from the provider was recorded.';
      plan.usePhone = phone.number;
    }
    return plan;
  });
  out.recipients = plans.length;

  try {
    db.transaction(() => {
      for (const pl of plans) {
        // template_name is "the approved template USED" — set only when a send is attempted.
        const attempting = pl.status === 'failed';
        pl.won = claim.run(
          pl.id, res.business_date, pl.email, pl.usePhone, pl.phone.source,
          attempting ? FSSAI_MISSED_WA_TEMPLATE : '', attempting ? FSSAI_MISSED_WA_LANG : '',
          pl.status, pl.skip, pl.detail.slice(0, 1000), pl.outlet,
        ).changes === 1;
      }
    })();
  } catch (e: any) {
    // The whole claim rolled back: nothing is recorded, so NOTHING is sent.
    out.outcome = 'failed';
    out.failed = plans.length;
    out.rows = plans.map((pl) => ({
      email: pl.email, status: 'failed' as const, skip_reason: 'provider_error' as const,
      phone_source: pl.phone.source, phone: '', notice_id: '', detail: `Could not be claimed: ${e?.message || e}`,
    }));
    out.detail = `The WhatsApp rows could not be written (${e?.message || e}), so nothing was sent.`;
    console.error(`[fssai-jobs] missed-checks whatsapp: ${out.detail}`);
    return out;
  }

  for (const pl of plans) {
    const { email, checks, phone, id, status, skip, detail, usePhone } = pl;
    if (!pl.won) {
      out.already_claimed += 1;
      out.rows.push({ email, status: 'already_claimed', skip_reason: '', phone_source: phone.source, phone: '', notice_id: '', detail: 'Already handled for this day by an earlier pass or another worker.' });
      continue;
    }

    if (status === 'dormant') {
      out.dormant += 1;
      out.rows.push({ email, status, skip_reason: skip, phone_source: phone.source, phone: '', notice_id: id, detail });
      continue;
    }
    if (status === 'skipped') {
      out.no_phone += 1;
      out.rows.push({ email, status, skip_reason: skip, phone_source: phone.source, phone: '', notice_id: id, detail });
      continue;
    }

    // THE SEND — an approved template, positional params, nothing else.
    let sendOk = false;
    let msgId = '';
    let why = '';
    try {
      const r = await sendWhatsAppTemplate(
        usePhone, FSSAI_MISSED_WA_TEMPLATE, FSSAI_MISSED_WA_LANG,
        fssaiMissedCheckWaParams(res.business_date, checks),
      );
      sendOk = !!r.ok;
      msgId = r.ok ? String(r.message_id || '') : '';
      why = r.ok ? '' : `${r.reason}${r.detail ? `: ${r.detail}` : ''}`;
    } catch (e: any) {
      why = `send_failed: ${e?.message || e}`;
    }
    try {
      db.prepare(
        `UPDATE fssai_job_notices
            SET status = ?, skip_reason = ?, provider_message_id = ?, detail = ?, updated_at = datetime('now')
          WHERE id = ?`,
      ).run(
        sendOk ? 'sent' : 'failed', sendOk ? '' : 'provider_error', msgId,
        sendOk ? `Sent the approved template "${FSSAI_MISSED_WA_TEMPLATE}" listing ${checks.length} check(s).` : `The provider refused it — ${why}`.slice(0, 1000),
        id,
      );
    } catch (e: any) {
      console.error('[fssai-jobs] missed-checks whatsapp: the send outcome could not be recorded:', e?.message);
    }
    if (sendOk) out.sent += 1; else out.failed += 1;
    out.rows.push({
      email, status: sendOk ? 'sent' : 'failed', skip_reason: sendOk ? '' : 'provider_error',
      phone_source: phone.source, phone: maskPhone(usePhone), notice_id: id, detail: sendOk ? '' : why,
    });
  }

  out.outcome = !ready.ready ? 'dormant'
    : out.sent && !out.failed && !out.no_phone ? 'sent'
      : out.sent ? 'partial'
        : out.failed ? 'failed'
          : 'none_sent';
  out.detail = !ready.ready
    ? `Dormant (bell only) for ${out.dormant} person(s): ${ready.blockers[0] || 'WhatsApp is not ready'}`
    : `${out.sent} sent, ${out.failed} failed, ${out.no_phone} with no number on file`
      + (out.already_claimed ? `, ${out.already_claimed} already handled` : '') + '.';
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. AN ABANDONED OR OVERDUE COOLING — OR REHEATING — BATCH: raise it, once
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * HOW LONG AFTER THE TIME LIMIT BEFORE A BATCH IS CALLED ABANDONED: 30 minutes.
 *
 * A reading at the target taken at minute 240 is often typed in at 245. Raising
 * the action at minute 241 would accuse a batch that finished on time of being
 * abandoned. Thirty minutes is long enough for a late entry and short enough
 * that the food is still in front of somebody. ASSUMPTION, REVERSIBLE: one line.
 * A reading at the target typed AFTER the action was raised does not withdraw
 * it — a manager closes it with that reading as the note. Reheating uses the
 * same grace.
 */
export const FSSAI_COOLING_OVERDUE_GRACE_MINUTES = 30;

/** Batches whose readings fall on today or the two days before are looked at. */
export const FSSAI_COOLING_OVERDUE_LOOKBACK_DAYS = 2;

/** Severity of the action an abandoned batch raises — 'urgent' = due the same day. */
export const FSSAI_COOLING_OVERDUE_SEVERITY = 'urgent';

/**
 * THE TWO CLOCK-JUDGED KINDS, AND THE JOB EACH ONE HAS (2026-10-15).
 * Only cooling was escalated; an abandoned REHEATING batch (20 °C at 07:00 and
 * never followed up) read "overdue" on the temperature screen and raised nothing
 * — no corrective action, no notice, no bell. Reheating now runs the same job
 * under its own job_key, so the two claims can never collide.
 */
export const FSSAI_CURVE_OVERDUE_JOBS = {
  cooling: { job_key: 'cooling_overdue', notice_kind: 'fssai_cooling_overdue', label: 'Cooling', actor: 'Cooling overdue check' },
  reheating: { job_key: 'reheating_overdue', notice_kind: 'fssai_reheating_overdue', label: 'Reheating', actor: 'Reheating overdue check' },
} as const;
export type FssaiCurveOverdueKind = keyof typeof FSSAI_CURVE_OVERDUE_JOBS;

export interface FssaiCoolingOverdueItem {
  curve_key: string;
  label: string;
  department_id: string;
  outlet_id: string;
  start: { id: string; business_date: string; reading_at: string; value: number | null; elapsed: number | null };
  last: { id: string; business_date: string; reading_at: string; value: number | null; elapsed: number | null };
  goal: number;
  max_minutes: number;
  uom: string;
  elapsed_now: number;
  /** IST 'YYYY-MM-DD HH:MM' at which the time limit ran out. */
  window_ended_at: string;
  /** 'overdue' = no reading at the target; 'reached_late' = the first reading at
   *  the target came after the time allowed, and nothing raised an action for it. */
  why: 'overdue' | 'reached_late';
  /** Actions already raised against single readings on this batch (behind schedule). */
  earlier_actions: string[];
  ca_id: string;
  ca_number: string;
  recipients: string[];
  people_told: number;
  /** true = raised on THIS pass; false = an earlier pass (or another worker) already had. */
  raised: boolean;
}

export interface FssaiCoolingOverdueResult {
  /** Which kind of batch this pass looked at, and the job key its claims use. */
  log_kind: FssaiCurveOverdueKind;
  job_key: string;
  outcome: 'none_overdue' | 'raised' | 'already_raised' | 'not_ready' | 'failed';
  /** IST instant this pass judged "now" by. */
  now_ist: string;
  scanned_curves: number;
  in_progress: number;
  /** Reached the target WITHIN the time allowed. */
  reached: number;
  /** Reached the target only after the time allowed (2026-10-15: these used to
   *  count as `reached` and were never escalated). */
  reached_late: number;
  /** No time limit or no target frozen on the first reading — nothing can be overdue. */
  unjudged: number;
  /** A reading taken AFTER the limit was filed and failed — that reading already raised its own action. */
  covered_by_reading: number;
  overdue: number;
  raised: number;
  already_raised: number;
  people_told: number;
  bell: 'on' | 'off';
  items: FssaiCoolingOverdueItem[];
  errors: string[];
  detail: string;
}

/** IST 'YYYY-MM-DD HH:MM' for a minute on fssaiClockMinute's clock. */
function clockMinuteWords(minute: number): string {
  return new Date(minute * 60_000).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * RAISE EVERY COOLING BATCH WHOSE TIME RAN OUT WITHOUT A READING AT THE TARGET
 * IN TIME. The cooling half of runFssaiCurveOverdueJob (job_key 'cooling_overdue').
 */
export function runFssaiCoolingOverdueJob(db: Db, opts: { now?: Date } = {}): FssaiCoolingOverdueResult {
  return runFssaiCurveOverdueJob(db, 'cooling', opts);
}

/**
 * THE SAME FOR REHEATING (job_key 'reheating_overdue'): a batch that never
 * reached its target (75 °C on the suggested rule) within the time allowed.
 */
export function runFssaiReheatingOverdueJob(db: Db, opts: { now?: Date } = {}): FssaiCoolingOverdueResult {
  return runFssaiCurveOverdueJob(db, 'reheating', opts);
}

/**
 * RAISE EVERY BATCH OF ONE CLOCK-JUDGED KIND WHOSE TIME RAN OUT WITHOUT A
 * READING AT THE TARGET IN TIME.
 *
 * Reads the batches exactly as the temperature screen does — fssaiCurveMembers
 * (the one membership rule), fssaiCurveReached (the one "got there" rule), the
 * FROZEN goal and time limit on the batch's first reading, minutes counted on
 * fssaiClockMinute's clock — so this job and the sheet cannot disagree about
 * which batch is overdue.
 *
 * A BATCH IS RAISED WHEN ALL OF:
 *   · its first live reading carries a time limit and a target (otherwise it
 *     was never judged on the clock — counted as `unjudged`, not raised);
 *   · EITHER no live reading on it is at the target and the time limit plus
 *     FSSAI_COOLING_OVERDUE_GRACE_MINUTES has passed ('overdue'),
 *     OR its first reading at the target came after the time limit
 *     ('reached_late' — 2026-10-15: these were counted as reached and never
 *     raised; the temperature route now fails such a reading itself, so this
 *     catches the ones filed before that, and any whose action was never
 *     written);
 *   · no reading taken AFTER the limit failed AND carries its own corrective
 *     action — the temperature route already judged that one a breach and
 *     raised an action for it, and a second one for the same fact would
 *     double-nag (`covered_by_reading`). A late failed reading whose action was
 *     never written (the route raises best-effort) does NOT cover the batch.
 *
 * WHAT IT WRITES, IN ONE TRANSACTION PER BATCH:
 *   1. THE CLAIM — fssai_job_notices (job_key, curve key, 'ca', '').
 *      INSERT OR IGNORE; changes === 1 means this pass owns the batch. Never
 *      raised twice, whatever ticks, workers or restarts follow.
 *   2. ONE corrective action (source_kind 'temperature', response_id = the
 *      batch's first live reading, run_id NULL, severity
 *      FSSAI_COOLING_OVERDUE_SEVERITY), its
 *      number from the module's allocator, and an fssai_audit_log 'create' row
 *      (THROWING — no action without its trail).
 *   3. THE BELL — task_notifications to the people who recorded the batch and
 *      their department's head (management when the department has none), each
 *      claimed on its own fssai_job_notices 'bell' row. With chasing switched
 *      off on the Chasing panel the action is still raised (it is a record, not
 *      a message) and each person's bell row says 'skipped' / 'disabled'.
 * If any of it throws, all of it rolls back and the next tick tries again.
 * No filed reading is changed.
 */
export function runFssaiCurveOverdueJob(
  db: Db,
  logKind: FssaiCurveOverdueKind,
  opts: { now?: Date } = {},
): FssaiCoolingOverdueResult {
  const meta = FSSAI_CURVE_OVERDUE_JOBS[logKind];
  const hot = logKind === 'reheating';
  const lower = meta.label.toLowerCase();
  const now = opts.now ?? new Date();
  const today = fssaiToday(now);
  const hhmm = istHHMMOf(now);
  const res: FssaiCoolingOverdueResult = {
    log_kind: logKind, job_key: meta.job_key,
    outcome: 'none_overdue', now_ist: `${today} ${hhmm}`, scanned_curves: 0, in_progress: 0, reached: 0, reached_late: 0,
    unjudged: 0, covered_by_reading: 0, overdue: 0, raised: 0, already_raised: 0, people_told: 0,
    bell: 'on', items: [], errors: [], detail: '',
  };
  const missing = ['fssai_temperature_logs', 'fssai_corrective_actions', 'fssai_job_notices', 'fssai_audit_log']
    .filter((t) => !tableExists(db, t));
  if (missing.length) {
    res.outcome = 'not_ready';
    res.detail = `Not in this database yet: ${missing.join(', ')}.`;
    return res;
  }
  const nowMinute = fssaiClockMinute(today, hhmm);
  if (nowMinute === null) {
    res.outcome = 'failed';
    res.detail = 'The clock did not give a usable time.';
    return res;
  }
  let bellOn = true;
  try { bellOn = readFssaiEscalationRules(db).enabled; } catch { bellOn = true; }
  res.bell = bellOn ? 'on' : 'off';

  try {
    const keys = db.prepare(
      `SELECT DISTINCT CASE WHEN batch_id <> '' THEN batch_id ELSE id END AS k
         FROM fssai_temperature_logs
        WHERE log_kind = ? AND status <> 'void'
          AND business_date >= ? AND business_date <= ?`,
    ).all(logKind, addDaysISO(today, -FSSAI_COOLING_OVERDUE_LOOKBACK_DAYS), today) as any[];

    const pushes: { email: string; title: string; body: string }[] = [];
    for (const { k } of keys) {
      const key = String(k || '');
      if (!key) continue;
      const members = fssaiCurveMembers(db, logKind, key);
      if (!members.length) continue;
      res.scanned_curves += 1;
      const start = members[0];
      const limit = start.max_minutes;
      const goal = start.goal;
      if (start.minute === null || limit === null || !(limit > 0) || goal === null) { res.unjudged += 1; continue; }
      const reachedM = fssaiCurveReached(members, logKind);
      const reachedLate = !!reachedM && !(reachedM.elapsed !== null && reachedM.elapsed <= limit);
      if (reachedM && !reachedLate) { res.reached += 1; continue; }
      const elapsedNow = (start.elapsed ?? 0) + (nowMinute - start.minute);
      if (!reachedLate && !(elapsedNow > limit + FSSAI_COOLING_OVERDUE_GRACE_MINUTES)) { res.in_progress += 1; continue; }
      if (reachedLate) res.reached_late += 1;
      /* COVERED only when a reading taken AFTER the limit failed AND that reading
       * really carries its corrective action. The route raises it best-effort
       * (raiseFssaiRecordCa: "a failure to raise cannot roll back the record"), so
       * a late failed reading whose action never got written would otherwise
       * leave an abandoned batch with NO action at all — the very gap this job
       * closes. The action's existence is read, not assumed from is_fail. Every
       * late reading is judged against the BATCH's limit (frozen on its first
       * reading), never a later rule's. */
      const lateFails = members.filter((m) => m.is_fail === 1 && m.elapsed !== null && m.elapsed > limit);
      if (lateFails.length) {
        const ph0 = lateFails.map(() => '?').join(',');
        const carried = Number((db.prepare(
          `SELECT COUNT(*) AS n FROM fssai_temperature_logs t
             JOIN fssai_corrective_actions ca ON ca.id = t.ca_id
            WHERE t.id IN (${ph0}) AND t.ca_id <> ''`,
        ).get(...lateFails.map((m) => m.id)) as any)?.n) || 0;
        if (carried > 0) {
          res.covered_by_reading += 1;
          continue;
        }
      }
      res.overdue += 1;

      const last = members[members.length - 1];
      const ids = members.map((m) => m.id);
      const ph = ids.map(() => '?').join(',');
      const first = db.prepare(
        `SELECT item_label, equipment_label, area_label, department_id, equipment_id, outlet_id
           FROM fssai_temperature_logs WHERE id = ?`,
      ).get(start.id) as any || {};
      const dept = String(first.department_id || '');
      const label = String(first.item_label || '') || String(first.equipment_label || '') || String(first.area_label || '') || 'an unnamed batch';
      const where = [first.equipment_label, first.area_label].map((v: any) => String(v || '')).filter(Boolean).filter((v) => v !== label).join(' · ');
      const earlier = (db.prepare(
        `SELECT DISTINCT ca.ca_number FROM fssai_corrective_actions ca
          WHERE ca.id IN (SELECT ca_id FROM fssai_temperature_logs WHERE id IN (${ph}) AND ca_id <> '')`,
      ).all(...ids) as any[]).map((r) => String(r.ca_number || '')).filter(Boolean);
      const recorders = normEmails(db.prepare(
        `SELECT DISTINCT u.email FROM fssai_temperature_logs t
           JOIN users u ON lower(u.email) = lower(trim(t.recorded_by)) AND u.is_active = 1
          WHERE t.id IN (${ph})`,
      ).all(...ids) as any[]);
      const heads = departmentHeads(db, dept);
      const recipients = [...new Set([...recorders, ...heads, ...(heads.length ? [] : managementTier(db))])];

      const u = start.uom === 'C' || start.uom === 'F' ? ` °${start.uom}` : ` ${start.uom}`;
      const side = hot ? 'at or above' : 'at or below';
      const endMinute = start.minute + (limit - (start.elapsed ?? 0));
      const item: FssaiCoolingOverdueItem = {
        curve_key: key, label, department_id: dept, outlet_id: String(first.outlet_id || ''),
        start: { id: start.id, business_date: start.business_date, reading_at: start.reading_at, value: start.value, elapsed: start.elapsed },
        last: { id: last.id, business_date: last.business_date, reading_at: last.reading_at, value: last.value, elapsed: last.elapsed },
        goal, max_minutes: limit, uom: start.uom, elapsed_now: elapsedNow,
        window_ended_at: clockMinuteWords(endMinute), why: reachedLate ? 'reached_late' : 'overdue', earlier_actions: earlier,
        ca_id: '', ca_number: '', recipients, people_told: 0, raised: false,
      };
      const title = (reachedLate
        ? `${meta.label} reached its target late — ${label}`
        : `${meta.label} not finished in time — ${label}`).slice(0, 300);
      const description = [
        reachedLate
          ? `This ${lower} batch did not reach its target within the time allowed.`
          : `This ${lower} batch passed its time limit without a reading at the target.`,
        `It started at ${start.value ?? '?'}${u} at ${start.reading_at} on ${start.business_date}${where ? ` (${where})` : ''}; the rule allows ${limit} minutes to reach ${goal}${u}, so its time ran out at ${item.window_ended_at.slice(11)} on ${item.window_ended_at.slice(0, 10)}.`,
        reachedLate && reachedM
          ? `The first reading ${side} ${goal}${u} was ${reachedM.value ?? '?'}${u} at ${reachedM.reading_at}, ${reachedM.elapsed ?? '?'} minutes in — after the ${limit} allowed.`
          : (members.length > 1
            ? `The last reading on it was ${last.value ?? '?'}${u} at ${last.reading_at} (${last.elapsed ?? '?'} minutes in), ${members.length} reading(s) in all.`
            : 'Only the first reading was ever taken.'),
        reachedLate ? '' : `No reading ${side} ${goal}${u} has been recorded, ${elapsedNow} minutes after it began.`,
        earlier.length ? `Already raised against single readings on this batch: ${earlier.join(', ')}.` : '',
        hot
          ? `Decide today what happened to this food and record it: reheated food that did not reach ${goal}${u} in time is not to be served or held; if it was discarded, say so.`
          : `Decide today what happened to this food and record it: if it was discarded, say so; if it is still held, it is not safe to use until a reading at the target is on file.`,
      ].filter(Boolean).join(' ');
      const bellTitle = title;

      const raise = db.transaction(() => {
        const claimId = generateId();
        const claimed = db.prepare(
          `INSERT OR IGNORE INTO fssai_job_notices
             (id, job_key, subject_key, channel, recipient_email, status, ref_table, detail, outlet_id)
           VALUES (?, ?, ?, 'ca', '', 'raised', 'fssai_corrective_actions', ?, ?)`,
        ).run(claimId, meta.job_key, key, reachedLate
          ? `Raised: the first reading at ${goal}${u} came ${reachedM?.elapsed ?? '?'} minutes in, past the ${limit}-minute window.`
          : `Raised ${elapsedNow} minutes into a ${limit}-minute window with no reading at ${goal}${u}.`, item.outlet_id);
        if (claimed.changes !== 1) return null;

        const caId = generateId();
        const caNumber = nextFssaiCaNumber(db, today);
        const due = fssaiCaDueDate(FSSAI_COOLING_OVERDUE_SEVERITY, today);
        /* response_id = the batch's FIRST LIVE READING — always a
         * fssai_temperature_logs id. The curve key is that same id unless the
         * kitchen named a production batch, in which case the key is the batch's
         * id and would point at no reading: the temperature screen counts a
         * batch's open actions by `response_id IN (its readings)`, so it would
         * not have seen this one. The curve key stays the claim's subject_key. */
        db.prepare(
          `INSERT INTO fssai_corrective_actions
             (id, ca_number, source_kind, run_id, response_id, equipment_id, department_id,
              title, description, severity, status, owner_email, due_date, created_by, outlet_id)
           VALUES (?, ?, 'temperature', NULL, ?, ?, ?, ?, ?, ?, 'open', '', ?, 'system', ?)`,
        ).run(caId, caNumber, start.id, String(first.equipment_id || ''), dept, title, description,
          FSSAI_COOLING_OVERDUE_SEVERITY, due, item.outlet_id);
        db.prepare(`UPDATE fssai_job_notices SET ref_id = ?, updated_at = datetime('now') WHERE id = ?`).run(caId, claimId);
        fssaiAudit(db, {
          entity_table: 'fssai_corrective_actions', entity_id: caId, action: 'create',
          after: {
            ca_number: caNumber, source_kind: 'temperature', source_table: 'fssai_temperature_logs',
            job_key: meta.job_key, log_kind: logKind, why: item.why,
            curve_key: key, start_reading_id: start.id, last_reading_id: last.id,
            reached_reading_id: reachedLate && reachedM ? reachedM.id : '',
            severity: FSSAI_COOLING_OVERDUE_SEVERITY, status: 'open', title,
            goal, max_minutes: limit, elapsed_now: elapsedNow, window_ended_at: item.window_ended_at,
          },
          reason: reachedLate
            ? `Raised automatically: this ${lower} batch first reached ${goal}${u} after its ${limit}-minute limit.`
            : `Raised automatically: this ${lower} batch passed its ${limit}-minute limit (plus ${FSSAI_COOLING_OVERDUE_GRACE_MINUTES} minutes' grace) without a reading at ${goal}${u}.`,
          actor: { email: 'system', name: meta.actor },
          outlet_id: item.outlet_id,
        });

        let told = 0;
        const bellClaim = db.prepare(
          `INSERT OR IGNORE INTO fssai_job_notices
             (id, job_key, subject_key, channel, recipient_email, status, skip_reason, ref_table, ref_id, detail, outlet_id)
           VALUES (?, ?, ?, 'bell', ?, ?, ?, 'fssai_corrective_actions', ?, ?, ?)`,
        );
        const bell = db.prepare(
          `INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href)
           VALUES (?, ?, ?, ?, ?, '', '/fssai/corrective-actions')`,
        );
        const body = `${caNumber}: ${description}`;
        for (const email of recipients) {
          const c = bellClaim.run(
            generateId(), meta.job_key, key, email, bellOn ? 'sent' : 'skipped', bellOn ? '' : 'disabled', caId,
            bellOn ? '' : 'Chasing is switched off on the Chasing panel; the action was raised, nobody was rung.',
            item.outlet_id,
          );
          if (c.changes !== 1 || !bellOn) continue;
          bell.run(generateId(), email, meta.notice_kind, bellTitle, body);
          told += 1;
          pushes.push({ email, title: bellTitle, body });
        }
        return { caId, caNumber, told };
      });

      try {
        const r = raise();
        if (!r) {
          res.already_raised += 1;
          const prior = db.prepare(
            `SELECT n.ref_id, IFNULL(ca.ca_number, '') AS ca_number FROM fssai_job_notices n
               LEFT JOIN fssai_corrective_actions ca ON ca.id = n.ref_id
              WHERE n.job_key = ? AND n.subject_key = ? AND n.channel = 'ca' AND n.recipient_email = ''`,
          ).get(meta.job_key, key) as any;
          item.ca_id = String(prior?.ref_id || '');
          item.ca_number = String(prior?.ca_number || '');
        } else {
          res.raised += 1;
          res.people_told += r.told;
          item.ca_id = r.caId;
          item.ca_number = r.caNumber;
          item.people_told = r.told;
          item.raised = true;
        }
      } catch (e: any) {
        res.errors.push(`${key}: ${e?.message || e}`);
        console.error(`[fssai-jobs] ${lower} overdue: batch ${key} could not be raised (rolled back, retried next tick):`, e?.message);
      }
      res.items.push(item);
    }

    // Push AFTER every commit, fire-and-forget: a push failure can never reach the tick.
    for (const p of pushes) {
      Promise.resolve()
        .then(() => sendPushToUser(db, p.email, { title: p.title, body: p.body, url: '/fssai/corrective-actions' }))
        .catch(() => { /* never */ });
    }
  } catch (e: any) {
    res.outcome = 'failed';
    res.errors.push(String(e?.message || e));
    res.detail = `The ${lower} overdue check failed: ${e?.message || e}`;
    console.error(`[fssai-jobs] ${res.detail}`);
    return res;
  }

  res.outcome = res.raised ? 'raised'
    : res.errors.length ? 'failed'
      : res.already_raised ? 'already_raised'
        : 'none_overdue';
  res.detail = res.raised
    ? `${res.raised} ${lower} batch(es) raised as corrective actions; ${res.people_told} person(s) told.`
    : res.errors.length ? `${res.errors.length} batch(es) could not be raised: ${res.errors.slice(0, 3).join('; ')}`
      : `${res.scanned_curves} ${lower} batch(es) looked at; none newly overdue.`;
  return res;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. THE OWNER'S RULINGS THAT ARE ABOUT DATA — applied wherever the app runs
 * ════════════════════════════════════════════════════════════════════════ */

/** Owner ruling Q19 (2026-10-14): "delete the leftover test template". */
export const FSSAI_Q19_TEMPLATE_CODE = 'ZZ-P2B-COLDROOM';

export interface FssaiRulingsResult {
  q19: {
    outcome: 'absent' | 'removed' | 'refused' | 'failed';
    template_id: string;
    detail: string;
  };
}

const KEY_Q19_NOTE = 'fssai_job_ruling_q19_note';

/**
 * APPLY THE OWNER'S DATA RULINGS. Safe on every tick: when there is nothing to
 * do it is one indexed SELECT.
 *
 * Q19 — THE LEFTOVER TEST CHECKLIST. ZZ-P2B-COLDROOM ("Cold room temperature —
 * closing round") was left behind by a build lane: a draft with no questions.
 * Nothing in this codebase seeds it (no pack, no boot step, no script names
 * it); it exists only in a database a lane once wrote it into. The owner ruled
 * it deleted, so on any database this app runs on it is deleted —
 *   ONLY while it is still exactly that: status 'draft', and NO row anywhere
 *   that points at it (every table whose foreign key references fssai_templates
 *   is counted, the CASCADE ones too, so nothing is ever removed silently along
 *   with it). A checklist somebody went on to use is not a leftover: it is
 *   REFUSED and said once in the server log, never deleted.
 *   In one transaction: the fssai_audit_log row (THROWING — no delete without
 *   its trail, carrying the whole row as it was) and then the DELETE, which
 *   must remove exactly one row or the whole thing rolls back.
 * A template is configuration, not evidence; the trail is the audit row.
 */
export function applyFssaiOwnerRulings(db: Db): FssaiRulingsResult {
  const out: FssaiRulingsResult = { q19: { outcome: 'absent', template_id: '', detail: '' } };
  try {
    if (!tableExists(db, 'fssai_templates')) return out;
    const row = db.prepare(`SELECT * FROM fssai_templates WHERE code = ?`).get(FSSAI_Q19_TEMPLATE_CODE) as any;
    if (!row) return out;
    out.q19.template_id = String(row.id);

    /* EVERY COLUMN THAT COULD POINT AT IT: each foreign key onto fssai_templates
     * (the CASCADE ones included), AND every column named `template_id` whether
     * or not it was declared as a key — a column added by ALTER, or a table
     * written without FKs (the 2026-10-14 tables have none by contract), would
     * otherwise be invisible here and the delete would orphan it. fssai_audit_log
     * is not a reference: it is the trail, and it outlives the template. */
    const refs: Record<string, number> = {};
    const cols = new Set<string>();
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as any[];
    for (const t of tables) {
      const name = String(t.name);
      if (!/^[A-Za-z0-9_]+$/.test(name) || name === 'fssai_templates' || name === 'fssai_audit_log') continue;
      let fks: any[] = [];
      try { fks = db.prepare(`PRAGMA foreign_key_list(${name})`).all() as any[]; } catch { fks = []; }
      for (const fk of fks) {
        if (String(fk.table) === 'fssai_templates') cols.add(`${name}.${String(fk.from)}`);
      }
      let info: any[] = [];
      try { info = db.prepare(`PRAGMA table_info(${name})`).all() as any[]; } catch { info = []; }
      for (const c of info) {
        if (String(c.name) === 'template_id') cols.add(`${name}.template_id`);
      }
    }
    for (const tc of cols) {
      const [name, col] = tc.split('.');
      if (!/^[A-Za-z0-9_]+$/.test(name) || !/^[A-Za-z0-9_]+$/.test(col || '')) continue;
      const n = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${name} WHERE ${col} = ?`).get(row.id) as any)?.n) || 0;
      if (n) refs[tc] = n;
    }
    const used = Object.entries(refs).map(([k, n]) => `${n} in ${k}`);
    if (String(row.status) !== 'draft' || used.length) {
      out.q19.outcome = 'refused';
      out.q19.detail = `"${FSSAI_Q19_TEMPLATE_CODE}" was NOT deleted: it is ${String(row.status) !== 'draft' ? `"${row.status}", not the draft it was` : 'still a draft'}${used.length ? `, and it is in use (${used.join(', ')})` : ''}. A checklist somebody used is archived, never deleted — this needs the owner.`;
      if (getSetting(db, KEY_Q19_NOTE) !== out.q19.detail) {
        setSetting(db, KEY_Q19_NOTE, out.q19.detail);
        console.error(`[fssai-jobs] ruling Q19: ${out.q19.detail}`);
      }
      return out;
    }

    const del = db.transaction(() => {
      fssaiAudit(db, {
        entity_table: 'fssai_templates', entity_id: String(row.id), action: 'delete',
        before: row,
        reason: `Owner ruling Q19 (2026-10-14): delete the leftover test checklist ${FSSAI_Q19_TEMPLATE_CODE}. It was a draft with no questions, sections, assignments or rounds — configuration, not evidence.`,
        actor: { email: 'system', name: 'Owner ruling Q19' },
        outlet_id: String(row.outlet_id || ''),
      });
      const r = db.prepare(`DELETE FROM fssai_templates WHERE id = ? AND code = ? AND status = 'draft'`)
        .run(row.id, FSSAI_Q19_TEMPLATE_CODE);
      if (r.changes !== 1) throw new Error(`expected to delete 1 row, deleted ${r.changes}`);
    });
    del();
    out.q19.outcome = 'removed';
    out.q19.detail = `Deleted the leftover test checklist ${FSSAI_Q19_TEMPLATE_CODE} ("${String(row.name || '')}") per owner ruling Q19; the fssai_audit_log row keeps it as it was.`;
    console.log(`[fssai-jobs] ruling Q19: ${out.q19.detail}`);
    return out;
  } catch (e: any) {
    out.q19.outcome = 'failed';
    out.q19.detail = `Ruling Q19 could not be applied: ${e?.message || e}`;
    console.error(`[fssai-jobs] ${out.q19.detail}`);
    return out;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6. WHAT THE UNATTENDED JOBS DID — for the Audit File and Inspection Mode
 * ════════════════════════════════════════════════════════════════════════ */

/** A heartbeat older than this means the driver is not ticking (off-hours cadence is 30 min). */
export const FSSAI_JOBS_ALIVE_MINUTES = 90;

export interface FssaiMissedDaySummary {
  business_date: string;
  /** Checks reported missed for that day — one fssai_audit_log 'remind_missed' row each. */
  checks_missed: number;
  /** People whose bell rang for that day (the day's claim row lists them). */
  bell_people: number;
  /** fssai_job_notices rows for that day, by outcome. One row per person. */
  whatsapp: { sent: number; failed: number; dormant: number; no_phone: number; skip_reasons: string[] };
}

export interface FssaiCoolingOverdueSummaryRow {
  curve_key: string;
  /** IST 'YYYY-MM-DD HH:MM' the action was raised. */
  raised_at: string;
  ca_id: string;
  ca_number: string;
  ca_status: string;
  ca_title: string;
  severity: string;
  due_date: string;
  people_rung: number;
  /** Bell rows written as skipped because chasing was switched off. */
  bell_skipped: number;
}

export interface FssaiJobsAuditSummary {
  since: string;
  until: string;
  /** Is the scheduler actually running these jobs? Read off its heartbeat, never assumed. */
  driver: { last_tick_at: string; minutes_since: number | null; alive: boolean; words: string };
  missed_checks: {
    days: FssaiMissedDaySummary[];
    whatsapp: { ready: boolean; skip_reason: FssaiJobSkipReason; blockers: string[] };
  };
  cooling_overdue: FssaiCoolingOverdueSummaryRow[];
  /** Abandoned REHEATING batches the job raised (job_key 'reheating_overdue'). */
  reheating_overdue: FssaiCoolingOverdueSummaryRow[];
  retention: {
    /** Owner ruling Q22, word for word. */
    ruling: string;
    swept_stores: string[];
    never_swept_stores: string[];
    last_run: { started_at: string; status: string; dropped: number; evidence_dropped: number; attachments_dropped: number; triggered_by: string; detail: string } | null;
  };
  rulings: { q19: { template_present: boolean; removed_at: string; words: string } };
  /** Anything that could not be read, in words. A missing table is said here, never a throw. */
  unreadable: string[];
}

/** IST 'YYYY-MM-DD HH:MM' of a stored UTC 'YYYY-MM-DD HH:MM:SS'; '' if unreadable. */
function istStamp(v: unknown): string {
  const ms = parseStoredInstant(v);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * EVERYTHING THE UNATTENDED FSSAI JOBS DID BETWEEN TWO BUSINESS DATES — READ-ONLY.
 *
 * For the Audit File page / PDF and Inspection Mode: the evidence that the
 * module chases itself, in one call. It answers, for [since, until]:
 *   · is the driver alive (heartbeat age, not a constant);
 *   · each day whose checks were missed — how many, how many people the bell
 *     rang, and what happened on WhatsApp per person (sent / failed / dormant /
 *     no number), plus whether WhatsApp is ready right now and if not, why;
 *   · each abandoned cooling batch the job raised — its action number, status
 *     and how many people were rung;
 *   · the photo-retention rule as the owner ruled it (Q22, verbatim), which
 *     stores the sweep walks and never walks, and its last run;
 *   · whether the Q19 leftover checklist is gone, and when it went.
 * No INSERT, UPDATE or DELETE. Every section is read in its own try, so an
 * absent table empties that section and is named in `unreadable`; it never
 * throws to the caller. Dates outside YYYY-MM-DD fall back to the last 30 days.
 */
export function fssaiJobsAuditSummary(
  db: Db,
  opts: { since?: string; until?: string; now?: Date } = {},
): FssaiJobsAuditSummary {
  const now = opts.now ?? new Date();
  const today = fssaiToday(now);
  const until = isISODate(opts.until) ? String(opts.until) : today;
  const since = isISODate(opts.since) ? String(opts.since) : addDaysISO(until, -29);
  const out: FssaiJobsAuditSummary = {
    since, until,
    driver: { last_tick_at: '', minutes_since: null, alive: false, words: '' },
    missed_checks: { days: [], whatsapp: { ready: false, skip_reason: '', blockers: [] } },
    cooling_overdue: [],
    reheating_overdue: [],
    retention: {
      ruling: FSSAI_Q22_RULING,
      swept_stores: [...FSSAI_RETENTION_SWEPT_STORES].filter((s) => !(FSSAI_RETENTION_NEVER_SWEPT_STORES as readonly string[]).includes(s)),
      never_swept_stores: [...FSSAI_RETENTION_NEVER_SWEPT_STORES],
      last_run: null,
    },
    rulings: { q19: { template_present: false, removed_at: '', words: '' } },
    unreadable: [],
  };

  // ── the driver
  try {
    const hb = readFssaiJobsHeartbeat(db);
    if (hb) {
      const ms = Date.parse(hb.at);
      out.driver.last_tick_at = hb.at;
      out.driver.minutes_since = Number.isFinite(ms) ? Math.max(0, Math.round((now.getTime() - ms) / 60_000)) : null;
      out.driver.alive = out.driver.minutes_since !== null && out.driver.minutes_since <= FSSAI_JOBS_ALIVE_MINUTES;
      out.driver.words = out.driver.alive
        ? `The food-safety jobs last ran ${out.driver.minutes_since} minute(s) ago.`
        : `The food-safety jobs have not run for ${out.driver.minutes_since ?? 'an unknown number of'} minute(s) — nothing is being chased or reminded until the server's scheduler runs again.`;
    } else {
      out.driver.words = 'The food-safety jobs have never run on this database — nothing has been chased, reminded or swept automatically.';
    }
  } catch (e: any) { out.unreadable.push(`heartbeat: ${e?.message || e}`); }

  // ── missed checks: the bell's day rows, the per-check audit rows, the WhatsApp rows
  const days = new Map<string, FssaiMissedDaySummary>();
  const day = (d: string): FssaiMissedDaySummary => {
    let x = days.get(d);
    if (!x) {
      x = { business_date: d, checks_missed: 0, bell_people: 0, whatsapp: { sent: 0, failed: 0, dormant: 0, no_phone: 0, skip_reasons: [] } };
      days.set(d, x);
    }
    return x;
  };
  try {
    if (tableExists(db, 'notifications')) {
      const rows = db.prepare(
        `SELECT event_date, recipient FROM notifications
          WHERE kind = 'fssai_checks_missed' AND event_date >= ? AND event_date <= ?`,
      ).all(since, until) as any[];
      for (const r of rows) {
        const d = String(r.event_date || '');
        if (!isISODate(d)) continue;
        day(d).bell_people = String(r.recipient || '').split(',').map((s) => s.trim()).filter(Boolean).length;
      }
    }
  } catch (e: any) { out.unreadable.push(`missed-check bell: ${e?.message || e}`); }
  try {
    if (tableExists(db, 'fssai_audit_log')) {
      // A day's reminder is written the next morning, so look one day past `until`.
      const rows = db.prepare(
        `SELECT after_json FROM fssai_audit_log
          WHERE entity_table = 'fssai_assignments' AND action = 'remind_missed'
            AND created_at >= ? AND created_at < ?`,
      ).all(since, addDaysISO(until, 2)) as any[];
      for (const r of rows) {
        let d = '';
        try { d = String(JSON.parse(String(r.after_json || '{}'))?.business_date || ''); } catch { d = ''; }
        if (isISODate(d) && d >= since && d <= until) day(d).checks_missed += 1;
      }
    }
  } catch (e: any) { out.unreadable.push(`missed-check audit rows: ${e?.message || e}`); }
  try {
    if (tableExists(db, 'fssai_job_notices')) {
      const rows = db.prepare(
        `SELECT subject_key, status, skip_reason, COUNT(*) AS n FROM fssai_job_notices
          WHERE job_key = 'missed_checks' AND channel = 'whatsapp' AND subject_key >= ? AND subject_key <= ?
          GROUP BY subject_key, status, skip_reason`,
      ).all(since, until) as any[];
      for (const r of rows) {
        const d = String(r.subject_key || '');
        if (!isISODate(d)) continue;
        const w = day(d).whatsapp;
        const n = Number(r.n) || 0;
        const st = String(r.status || '');
        if (st === 'sent') w.sent += n;
        else if (st === 'dormant') w.dormant += n;
        else if (st === 'skipped') w.no_phone += n;
        else w.failed += n;
        const why = String(r.skip_reason || '');
        if (why && !w.skip_reasons.includes(why)) w.skip_reasons.push(why);
      }
    } else {
      out.unreadable.push('fssai_job_notices is not in this database.');
    }
  } catch (e: any) { out.unreadable.push(`missed-check whatsapp rows: ${e?.message || e}`); }
  out.missed_checks.days = [...days.values()].sort((a, b) => b.business_date.localeCompare(a.business_date));
  try {
    const r = fssaiMissedCheckWaReadiness(db);
    out.missed_checks.whatsapp = { ready: r.ready, skip_reason: r.skip_reason, blockers: r.blockers };
  } catch (e: any) { out.unreadable.push(`whatsapp readiness: ${e?.message || e}`); }

  // ── abandoned cooling (and reheating) batches the job raised
  for (const [jobKey, sink] of [['cooling_overdue', out.cooling_overdue], ['reheating_overdue', out.reheating_overdue]] as const) try {
    if (tableExists(db, 'fssai_job_notices') && tableExists(db, 'fssai_corrective_actions')) {
      const rows = db.prepare(
        `SELECT n.subject_key, n.created_at, n.ref_id,
                IFNULL(ca.ca_number, '') AS ca_number, IFNULL(ca.status, '') AS ca_status,
                IFNULL(ca.title, '') AS ca_title, IFNULL(ca.severity, '') AS severity, IFNULL(ca.due_date, '') AS due_date
           FROM fssai_job_notices n
           LEFT JOIN fssai_corrective_actions ca ON ca.id = n.ref_id
          WHERE n.job_key = ? AND n.channel = 'ca'
            AND date(n.created_at, '+330 minutes') >= ? AND date(n.created_at, '+330 minutes') <= ?
          ORDER BY n.created_at DESC, n.rowid DESC`,
      ).all(jobKey, since, until) as any[];
      const bells = db.prepare(
        `SELECT SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS rung,
                SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
           FROM fssai_job_notices WHERE job_key = ? AND channel = 'bell' AND subject_key = ?`,
      );
      for (const r of rows) {
        const b = bells.get(jobKey, String(r.subject_key || '')) as any;
        sink.push({
          curve_key: String(r.subject_key || ''), raised_at: istStamp(r.created_at),
          ca_id: String(r.ref_id || ''), ca_number: String(r.ca_number || ''), ca_status: String(r.ca_status || ''),
          ca_title: String(r.ca_title || ''), severity: String(r.severity || ''), due_date: String(r.due_date || ''),
          people_rung: Number(b?.rung) || 0, bell_skipped: Number(b?.skipped) || 0,
        });
      }
    }
  } catch (e: any) { out.unreadable.push(`${jobKey.replace('_', ' ')}: ${e?.message || e}`); }

  // ── retention: the ruling, and what the sweep last did
  try {
    const last = listFssaiRetentionRuns(db, 1)[0];
    if (last) {
      out.retention.last_run = {
        started_at: last.started_at, status: last.status, dropped: last.dropped_count,
        evidence_dropped: last.evidence_dropped, attachments_dropped: last.attachments_dropped,
        triggered_by: last.triggered_by, detail: last.detail,
      };
    }
  } catch (e: any) { out.unreadable.push(`retention runs: ${e?.message || e}`); }

  // ── Q19
  try {
    if (tableExists(db, 'fssai_templates')) {
      out.rulings.q19.template_present = !!db.prepare(`SELECT 1 FROM fssai_templates WHERE code = ?`).get(FSSAI_Q19_TEMPLATE_CODE);
    }
    if (tableExists(db, 'fssai_audit_log')) {
      const del = db.prepare(
        `SELECT created_at FROM fssai_audit_log
          WHERE entity_table = 'fssai_templates' AND action = 'delete' AND reason LIKE 'Owner ruling Q19%'
          ORDER BY rowid DESC LIMIT 1`,
      ).get() as any;
      out.rulings.q19.removed_at = del ? istStamp(del.created_at) : '';
    }
    out.rulings.q19.words = out.rulings.q19.template_present
      ? `The leftover test checklist ${FSSAI_Q19_TEMPLATE_CODE} is still on file${getSetting(db, KEY_Q19_NOTE) ? ` — ${getSetting(db, KEY_Q19_NOTE)}` : ' (the next scheduler pass removes it if it is still the empty draft).'}`
      : out.rulings.q19.removed_at
        ? `The leftover test checklist ${FSSAI_Q19_TEMPLATE_CODE} was deleted on ${out.rulings.q19.removed_at} IST by owner ruling Q19; the audit log keeps it as it was.`
        : `The leftover test checklist ${FSSAI_Q19_TEMPLATE_CODE} is not in this database.`;
  } catch (e: any) { out.unreadable.push(`ruling Q19: ${e?.message || e}`); }

  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE TICK
 * ════════════════════════════════════════════════════════════════════════ */

export interface FssaiJobsReport {
  at: string;
  escalation: FssaiEscalationJobResult | { error: string };
  retention: FssaiRetentionJobResult | { error: string };
  missed_checks: FssaiMissedCheckResult | { error: string };
  /** The WhatsApp leg of missed_checks (owner ruling 2026-10-14). */
  missed_checks_whatsapp: FssaiMissedWaResult | { error: string };
  cooling_overdue: FssaiCoolingOverdueResult | { error: string };
  /** The same job for reheating batches (2026-10-15). */
  reheating_overdue: FssaiCoolingOverdueResult | { error: string };
  rulings: FssaiRulingsResult | { error: string };
}

/**
 * Everything FSSAI does unattended, once per scheduler tick. Each job is in its
 * own try, so one failing cannot starve the others. Ends by stamping a
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
    missed_checks_whatsapp: { error: 'not run' },
    cooling_overdue: { error: 'not run' },
    reheating_overdue: { error: 'not run' },
    rulings: { error: 'not run' },
  };
  try { report.escalation = await runFssaiEscalationJob(db); } catch (e: any) { report.escalation = { error: String(e?.message || e) }; }
  try { report.retention = runFssaiRetentionJob(db, { now }); } catch (e: any) { report.retention = { error: String(e?.message || e) }; }
  try { report.missed_checks = runFssaiMissedCheckReminders(db, { now }); } catch (e: any) { report.missed_checks = { error: String(e?.message || e) }; }
  try {
    const mc: any = report.missed_checks;
    report.missed_checks_whatsapp = mc.error
      ? { error: `the bell pass failed, so WhatsApp was not tried: ${mc.error}` }
      : await runFssaiMissedCheckWhatsApp(db, mc as FssaiMissedCheckResult);
  } catch (e: any) { report.missed_checks_whatsapp = { error: String(e?.message || e) }; }
  try { report.cooling_overdue = runFssaiCoolingOverdueJob(db, { now }); } catch (e: any) { report.cooling_overdue = { error: String(e?.message || e) }; }
  try { report.reheating_overdue = runFssaiReheatingOverdueJob(db, { now }); } catch (e: any) { report.reheating_overdue = { error: String(e?.message || e) }; }
  try { report.rulings = applyFssaiOwnerRulings(db); } catch (e: any) { report.rulings = { error: String(e?.message || e) }; }

  try {
    const esc: any = report.escalation;
    const ret: any = report.retention;
    const mis: any = report.missed_checks;
    const wa: any = report.missed_checks_whatsapp;
    const cool: any = report.cooling_overdue;
    const reheat: any = report.reheating_overdue;
    const rul: any = report.rulings;
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
        whatsapp: wa.error ? { error: wa.error } : {
          outcome: wa.outcome, skip_reason: wa.readiness?.skip_reason || '', sent: wa.sent, failed: wa.failed,
          dormant: wa.dormant, no_phone: wa.no_phone,
        },
      },
      cooling_overdue: cool.error ? { error: cool.error } : {
        outcome: cool.outcome, scanned: cool.scanned_curves, overdue: cool.overdue, raised: cool.raised,
        people_told: cool.people_told, errors: (cool.errors || []).length,
      },
      reheating_overdue: reheat.error ? { error: reheat.error } : {
        outcome: reheat.outcome, scanned: reheat.scanned_curves, overdue: reheat.overdue, raised: reheat.raised,
        people_told: reheat.people_told, errors: (reheat.errors || []).length,
      },
      rulings: rul.error ? { error: rul.error } : { q19: rul.q19?.outcome || '' },
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
  const wa: any = r.missed_checks_whatsapp;
  if (wa?.error) parts.push(`missed-checks whatsapp ERROR ${wa.error}`);
  else if (wa && wa.outcome !== 'not_run') parts.push(`missed-checks whatsapp ${wa.outcome}: ${wa.detail}`);
  const cool: any = r.cooling_overdue;
  if (cool?.error) parts.push(`cooling-overdue ERROR ${cool.error}`);
  else if (cool && ['raised', 'failed'].includes(cool.outcome)) parts.push(`cooling-overdue ${cool.outcome}: ${cool.detail}`);
  const reheat: any = r.reheating_overdue;
  if (reheat?.error) parts.push(`reheating-overdue ERROR ${reheat.error}`);
  else if (reheat && ['raised', 'failed'].includes(reheat.outcome)) parts.push(`reheating-overdue ${reheat.outcome}: ${reheat.detail}`);
  const rul: any = r.rulings;
  if (rul?.error) parts.push(`rulings ERROR ${rul.error}`);
  else if (rul?.q19 && ['removed', 'failed'].includes(rul.q19.outcome)) parts.push(`ruling Q19 ${rul.q19.outcome}: ${rul.q19.detail}`);
  return parts.length ? parts.join(' · ') : null;
}
