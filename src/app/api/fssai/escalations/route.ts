/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import { canAuthorFssai, fssaiToday } from '@/lib/fssai';
import { requireFssaiUser, fssaiCsrfGuard, str } from '@/lib/fssai-server';
import { readFssaiJobsHeartbeat } from '@/lib/fssai-jobs';
import { fmtIST } from '@/lib/format-date';
import {
  readFssaiEscalationRules, writeFssaiEscalationRules, sweepFssaiCaAlerts,
  flushFssaiAlertSlack, fssaiEscalationPicture, isFssaiEscalationTarget,
  FSSAI_ESCALATION_DEFAULTS, FSSAI_ESCALATION_TARGETS, FSSAI_ALERT_KINDS,
  type FssaiEscalationRules, type FssaiEscalationTarget,
} from '@/lib/fssai-alerts';

/**
 * CHASING AND ESCALATION (/api/fssai/escalations) — the owner's §23.
 *
 * This is the half of P7 that was missing: the corrective-action spine recorded
 * a fix and a check on the fix, and nothing ever told anybody an action was
 * late. A red "Late" badge for whoever happens to open the queue is not a chase.
 *
 *   GET                       → { rules, picture, targets, kinds, can_edit, defaults }
 *   POST { action:'save_rules', rules:{…} }   admin — the §23 configuration
 *   POST { action:'sweep', force? }           management — run the chase now
 *
 * ── WHY THERE IS NO CRON PATH HERE, STATED RATHER THAN DISCOVERED ───────────
 * Every other unattended job in this app offers an `x-cron-token` bypass
 * (/api/cron/refresh-parties:31). ONE CANNOT WORK HERE, and the reason is
 * structural rather than an omission: src/proxy.ts validates the session cookie
 * against the sessions table for EVERY state-changing /api call (proxy.ts
 * step 2c) and requires the CSRF pair for every path under '/api/fssai'
 * (CSRF_REQUIRED_PREFIXES:104) — both BEFORE the handler runs. A token-only POST
 * is therefore refused 401 by the proxy and never reaches this file. Adding a
 * token check below would be a guard that reads correctly and can never fire,
 * which is the one pattern this project has been bitten by repeatedly.
 *
 * So the chase is armed three ways:
 *   1. this route's POST, from the button on /fssai/corrective-actions;
 *   2. a THROTTLED ride-along on GET /api/fssai/corrective-actions, so simply
 *      opening the queue chases whatever is late;
 *   3. UNATTENDED, by the app's in-process scheduler (src/lib/scheduler.ts →
 *      runFssaiScheduledJobs in src/lib/fssai-jobs.ts), which stamps
 *      settings.fssai_job_heartbeat at the end of every tick.
 *
 * ── WHAT THE SCREEN IS TOLD ABOUT (3) COMES FROM THE HEARTBEAT, NOT THE CODE ─
 * That (3) is WIRED is not evidence that it RUNS: the scheduler is
 * production-only unless ENABLE_SCHEDULER=1, a stopped server ticks nothing, and
 * a copied database carries somebody else's last tick. So `arming` and `jobs`
 * below are built from readFssaiJobsHeartbeat() alone — when the jobs last ran
 * and what that run did — and say "no record of it ever running" or "it has
 * stopped" when that is what the heartbeat shows. /fssai/audit-log reads the
 * same `jobs` for the photo-retention sweep, so the two screens cannot disagree.
 */
export const dynamic = 'force-dynamic';

/* ══════════════════════════════════════════════════════════════════════════
 * THE HEARTBEAT, IN WORDS
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * How late a heartbeat may be before the driver is called stopped. The
 * scheduler picks its next delay at the END of a tick from the IST hour: 5
 * minutes from 08:00 to 22:59, 30 minutes otherwise (scheduler.ts
 * POLL_BUSINESS_MIN / POLL_OFFHOURS_MIN). Two missed ticks plus room for a slow
 * tick (a Sheets refresh, the WhatsApp jobs) — later than that, nothing is
 * running.
 */
function jobsStaleAfterMin(lastTickMs: number): number {
  const h = new Date(lastTickMs + 5.5 * 3600_000).getUTCHours();
  const delay = h >= 8 && h < 23 ? 5 : 30;
  return delay * 2 + 15;
}

function agoWords(min: number): string {
  if (min < 1) return 'less than a minute ago';
  if (min < 90) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hours ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}

function pictures(n: number): string {
  return n === 0 ? 'no pictures' : `${n} picture${n === 1 ? '' : 's'}`;
}

type FssaiJobsState = 'never' | 'running' | 'stopped';

interface FssaiJobsTruth {
  /** never = no heartbeat on this database; stopped = one exists but is too old. */
  state: FssaiJobsState;
  /** ISO instant of the last tick that ran the FSSAI jobs, '' when there is none. */
  last_tick_at: string;
  minutes_since: number | null;
  stale_after_minutes: number | null;
  /** What the LAST tick's chase did. null when there is no heartbeat. */
  chase: {
    outcome: 'chased' | 'throttled' | 'disabled' | 'failed' | 'unknown';
    people_told: number;
    errors: number;
    words: string;
  } | null;
  /** What the LAST tick's retention pass did, plus the last pass the scheduler recorded. */
  retention: {
    tick_outcome: string;
    tick_day: string;
    tick_dropped: number;
    words: string;
    last_pass: null | {
      id: string; started_at: string; finished_at: string; status: string;
      scanned: number; dropped: number; detail: string;
    };
  } | null;
  /** The raw heartbeat, unedited, for anybody who needs the third job too. */
  heartbeat: Record<string, unknown> | null;
  chase_sentence: string;
  retention_sentence: string;
}

/** The newest fssai_retention_runs row the scheduler wrote — evidence, not a heartbeat. */
function lastScheduledRetentionPass(db: any): NonNullable<FssaiJobsTruth['retention']>['last_pass'] {
  try {
    const r = db.prepare(
      `SELECT id, started_at, finished_at, status, scanned_count, dropped_count, detail
         FROM fssai_retention_runs
        WHERE triggered_by = 'scheduler'
        ORDER BY rowid DESC LIMIT 1`,
    ).get() as any;
    if (!r) return null;
    return {
      id: String(r.id), started_at: String(r.started_at || ''), finished_at: String(r.finished_at || ''),
      status: String(r.status || ''), scanned: Number(r.scanned_count) || 0,
      dropped: Number(r.dropped_count) || 0, detail: String(r.detail || ''),
    };
  } catch {
    return null;   // the table is not on this database yet — no pass can have been recorded
  }
}

function fssaiJobsTruth(db: any, nowMs = Date.now()): FssaiJobsTruth {
  const hb = readFssaiJobsHeartbeat(db) as any;
  const atMs = hb ? Date.parse(String(hb.at)) : NaN;
  const lastPass = lastScheduledRetentionPass(db);

  const passWords = lastPass
    ? `The last pass the scheduler recorded was ${fmtIST(lastPass.started_at)}: ${
      lastPass.status === 'done'
        ? `${pictures(lastPass.dropped)} dropped`
        : lastPass.status === 'running' && !lastPass.finished_at
          ? 'it did not finish'
          : 'it did not sweep — see why in the list below'
    }.`
    : '';

  if (!hb || !Number.isFinite(atMs)) {
    return {
      state: 'never', last_tick_at: '', minutes_since: null, stale_after_minutes: null,
      chase: null, retention: null, heartbeat: null,
      chase_sentence:
        'There is no record of the server’s scheduler ever running the food-safety jobs on this database, '
        + 'so nothing chases a late action on a timer here. A late action is chased only when somebody opens '
        + 'the corrective-action queue or a manager presses “Chase now”.',
      retention_sentence:
        'There is no record of the server’s scheduler ever running the food-safety jobs on this database, '
        + 'so the photo sweep has never run by itself here. '
        + (passWords ? `${passWords} ` : '')
        + 'Until it does, pictures past the window are dropped only when an administrator runs the sweep below.',
    };
  }

  const minutes = Math.max(0, Math.floor((nowMs - atMs) / 60_000));
  const staleAfter = jobsStaleAfterMin(atMs);
  const state: FssaiJobsState = minutes <= staleAfter ? 'running' : 'stopped';
  const when = `${fmtIST(hb.at)} (${agoWords(minutes)})`;

  /* ── the chase, as the last tick left it ─────────────────────────────── */
  const esc = hb.escalation && typeof hb.escalation === 'object' ? hb.escalation : {};
  const escErrors = Number(esc.errors) || 0;
  const told = Number(esc.people_told) || 0;
  let chase: NonNullable<FssaiJobsTruth['chase']>;
  // Every `words` is a verb phrase: the sentences read "…last ran <when> and <words>".
  if (esc.error) {
    chase = { outcome: 'failed', people_told: 0, errors: 1, words: `failed to chase: ${String(esc.error)}` };
  } else if (esc.ran) {
    chase = {
      outcome: 'chased', people_told: told, errors: escErrors,
      words: (told > 0
        ? `chased late actions and sent ${told} notification${told === 1 ? '' : 's'}`
        : 'chased late actions and found nothing new to send')
        + (escErrors ? ` (${escErrors} error${escErrors === 1 ? '' : 's'} — see the server log)` : ''),
    };
  } else if (esc.skipped === 'throttled') {
    chase = {
      outcome: 'throttled', people_told: 0, errors: escErrors,
      words: 'did not need to chase, because a chase had already run in the ten minutes before',
    };
  } else if (esc.skipped === 'disabled') {
    chase = { outcome: 'disabled', people_told: 0, errors: 0, words: 'sent nothing, because chasing is switched off' };
  } else {
    chase = { outcome: 'unknown', people_told: 0, errors: escErrors, words: 'left no readable note of what the chase did' };
  }

  /* ── the retention pass, as the last tick left it ────────────────────── */
  const ret = hb.retention && typeof hb.retention === 'object' ? hb.retention : {};
  const tickOutcome = ret.error ? 'error' : String(ret.outcome || '');
  const tickDay = String(ret.day || '');
  const tickDropped = Number(ret.dropped) || 0;
  const retWords = ret.error
    ? `the retention pass failed: ${String(ret.error)}`
    : tickOutcome === 'not_due' ? 'the retention pass was not due — it runs from 03:00 IST'
      : tickOutcome === 'already_ran_today' ? `the retention pass for ${tickDay} had already been made`
        : tickOutcome === 'swept' ? `it made the retention pass for ${tickDay} and dropped ${pictures(tickDropped)}`
          : tickOutcome === 'refused' ? 'it refused to sweep, because it could not prove every picture was 12 months old'
            : tickOutcome === 'failed' ? 'the retention pass failed'
              : 'it left no readable note of the retention pass';
  /* When the last tick IS the last recorded pass, its words already say what
   * that pass did; repeating them as "the last pass recorded" adds nothing. */
  const passIsThisTick = !!lastPass && !!ret.retention_run_id && String(ret.retention_run_id) === lastPass.id;

  const retention = {
    tick_outcome: tickOutcome, tick_day: tickDay, tick_dropped: tickDropped, words: retWords, last_pass: lastPass,
  };

  if (state === 'running') {
    return {
      state, last_tick_at: String(hb.at), minutes_since: minutes, stale_after_minutes: staleAfter,
      chase, retention, heartbeat: hb,
      chase_sentence:
        `Late actions are chased by the server on its own. Its scheduler last ran ${when} and ${chase.words}. `
        + 'It runs every 5 minutes from 08:00 to 23:00 IST and every 30 minutes overnight; opening the '
        + 'corrective-action queue and “Chase now” chase as well.',
      retention_sentence:
        'The photo sweep runs by itself once a day from 03:00 IST, and refuses rather than drops any picture it '
        + `cannot prove is at least 12 months old. The scheduler last ran ${when}; on that run ${retWords}.`
        + (passIsThisTick ? '' : ` ${passWords || 'It has not recorded a scheduled pass on this database yet.'}`),
    };
  }

  return {
    state, last_tick_at: String(hb.at), minutes_since: minutes, stale_after_minutes: staleAfter,
    chase, retention, heartbeat: hb,
    chase_sentence:
      `The server is meant to chase late actions on its own, but its scheduler last ran ${when} and runs every `
      + '5 to 30 minutes, so it is not running now. On that last run it '
      + `${chase.words}. Until it is back, a late action is chased only when somebody opens the `
      + 'corrective-action queue or a manager presses “Chase now”.',
    retention_sentence:
      'The photo sweep is meant to run by itself once a day, but the server’s scheduler last ran '
      + `${when}, so it is not running now. On that last run ${retWords}. `
      + (passIsThisTick ? '' : passWords ? `${passWords} ` : 'It never recorded a scheduled pass on this database. ')
      + 'Until it is back, pictures past the window are dropped only when an administrator runs the sweep below.',
  };
}

/** Read one boolean out of the request body, falling back to what is saved. */
function pickBool(raw: any, current: boolean): boolean {
  if (raw === true || raw === 1 || raw === '1' || raw === 'true') return true;
  if (raw === false || raw === 0 || raw === '0' || raw === 'false') return false;
  return current;
}

/**
 * Read one whole number, REFUSING junk by name rather than silently keeping the
 * old value — an admin who typed 30 and was quietly given 1 would never know.
 */
function pickInt(raw: any, current: number, min: number, max: number, label: string): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') return current;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${label} has to be a whole number between ${min} and ${max}.`);
  }
  return n;
}

function pickTargets(raw: any, current: FssaiEscalationTarget[], label: string): FssaiEscalationTarget[] {
  if (raw === undefined || raw === null) return current;
  if (!Array.isArray(raw)) throw new Error(`${label} has to be a list.`);
  const out: FssaiEscalationTarget[] = [];
  for (const v of raw) {
    if (!isFssaiEscalationTarget(v)) throw new Error(`"${String(v)}" is not somebody this can escalate to.`);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

export async function GET() {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  /* THE RULES AND THE PICTURE ARE MANAGEMENT'S. A porter's phone has no reason
   * to carry the escalation matrix — it names who gets told when the restaurant
   * fails to fix something, which is supervisory information. The chase still
   * reaches a staff member's own feed; this is the console for it. */
  if (!isManagement(me)) {
    return Response.json(
      { error: 'Only a manager, head of department or administrator can see the chasing rules.' },
      { status: 403 },
    );
  }

  try {
    const db = getDb();
    const today = fssaiToday();
    const jobs = fssaiJobsTruth(db);
    return Response.json({
      rules: readFssaiEscalationRules(db),
      defaults: FSSAI_ESCALATION_DEFAULTS,
      picture: fssaiEscalationPicture(db, today),
      targets: FSSAI_ESCALATION_TARGETS,
      kinds: FSSAI_ALERT_KINDS,
      can_edit: canAuthorFssai(me),
      today,
      /* The one sentence a reader needs so the screen neither over- nor
       * under-promises — read off the scheduler's heartbeat, never assumed. */
      arming: jobs.chase_sentence,
      jobs,
    });
  } catch (e: any) {
    console.error('GET /api/fssai/escalations failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the chasing rules' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { /* validated below */ }
  const action = str(body?.action);

  try {
    const db = getDb();

    /* ══════════════════════════════════════════════════════════════════════
     * SAVE THE RULES — admin only (owner §20: the administrator configures).
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'save_rules') {
      if (!canAuthorFssai(me)) {
        return Response.json(
          { error: 'Only an administrator can change who gets told about a late corrective action.' },
          { status: 403 },
        );
      }
      const current = readFssaiEscalationRules(db);
      const incoming = (body?.rules && typeof body.rules === 'object') ? body.rules : {};
      let next: FssaiEscalationRules;
      try {
        const level1 = pickInt(incoming.level1_after_days, current.level1_after_days, 0, 365, 'The first escalation');
        const level2 = pickInt(incoming.level2_after_days, current.level2_after_days, 0, 365, 'The second escalation');
        if (level2 < level1) {
          return Response.json(
            {
              error: 'The second escalation cannot happen before the first. '
                + `Set it to ${level1} days or more.`,
            },
            { status: 400 },
          );
        }
        next = {
          enabled: pickBool(incoming.enabled, current.enabled),
          remind_before_days: pickInt(incoming.remind_before_days, current.remind_before_days, 0, 30, 'The reminder before the due date'),
          remind_on_due: pickBool(incoming.remind_on_due, current.remind_on_due),
          remind_overdue_daily: pickBool(incoming.remind_overdue_daily, current.remind_overdue_daily),
          level1_after_days: level1,
          level2_after_days: level2,
          level1_targets: pickTargets(incoming.level1_targets, current.level1_targets, 'The first escalation list'),
          level2_targets: pickTargets(incoming.level2_targets, current.level2_targets, 'The second escalation list'),
          urgent_escalates_same_day: pickBool(incoming.urgent_escalates_same_day, current.urgent_escalates_same_day),
          unassigned_escalates_after_hours: pickInt(
            incoming.unassigned_escalates_after_hours, current.unassigned_escalates_after_hours,
            0, 720, 'The wait before an unowned action is escalated',
          ),
          slack: pickBool(incoming.slack, current.slack),
          auto_create_task: pickBool(incoming.auto_create_task, current.auto_create_task),
        };
      } catch (ve: any) {
        return Response.json({ error: ve?.message || 'Those rules are not valid.' }, { status: 400 });
      }

      const outletId = (await getCurrentOutletId()) || '';
      const saved = writeFssaiEscalationRules(db, next, { email: me.email, name: me.name }, outletId);
      return Response.json({
        ok: true,
        rules: saved,
        /* SAID OUT LOUD because it is the one consequence an admin will not
         * expect: the rules decide what is sent NEXT, and yesterday's
         * escalations stay in the file exactly as they were sent. */
        note: saved.enabled
          ? 'Saved. This changes what gets sent from now on — nothing already sent is rewritten.'
          : 'Saved, and chasing is now OFF. Nobody will be told about a late corrective action until it is switched back on.',
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * RUN THE CHASE NOW — management, because it sends messages to people.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'sweep') {
      if (!isManagement(me)) {
        return Response.json(
          { error: 'Only a manager, head of department or administrator can run the chase.' },
          { status: 403 },
        );
      }
      const result = sweepFssaiCaAlerts(db, { force: body?.force !== false });
      // Slack AFTER the sweep: better-sqlite3 is synchronous and the sweep runs
      // inside transactions, so the network call cannot live in there.
      const slack = await flushFssaiAlertSlack(db);
      return Response.json({
        ok: true,
        result,
        slack,
        picture: fssaiEscalationPicture(db),
        message: result.skipped === 'disabled'
          ? 'Chasing is switched off, so nothing was sent.'
          : result.people_told > 0
            ? `${result.people_told} notification${result.people_told === 1 ? '' : 's'} sent.`
            : 'Nothing needed chasing — everything outstanding has already been told about today.',
      });
    }

    return Response.json(
      { error: `"${action || 'nothing'}" is not something this does. Use save_rules or sweep.` },
      { status: 400 },
    );
  } catch (e: any) {
    console.error('POST /api/fssai/escalations failed:', e);
    return Response.json({ error: e?.message || 'Failed to do that' }, { status: 500 });
  }
}
