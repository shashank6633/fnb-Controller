/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import { canAuthorFssai, fssaiToday } from '@/lib/fssai';
import { requireFssaiUser, fssaiCsrfGuard, str } from '@/lib/fssai-server';
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
 * So the chase is armed three ways, none of which touches a shared file:
 *   1. this route's POST, from the button on /fssai/corrective-actions;
 *   2. a THROTTLED ride-along on GET /api/fssai/corrective-actions, so simply
 *      opening the queue chases whatever is late (the pattern the GRN QC
 *      escalation used before it reached the scheduler);
 *   3. truly unattended arming needs ONE line in src/lib/scheduler.ts, which
 *      this lane may not edit. It is written out in the lane report so it can be
 *      added deliberately by whoever owns that file.
 * Until (3) exists the honest sentence is: an action is chased the first time
 * somebody opens a food-safety screen that day. The screen says so.
 */
export const dynamic = 'force-dynamic';

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
    return Response.json({
      rules: readFssaiEscalationRules(db),
      defaults: FSSAI_ESCALATION_DEFAULTS,
      picture: fssaiEscalationPicture(db, today),
      targets: FSSAI_ESCALATION_TARGETS,
      kinds: FSSAI_ALERT_KINDS,
      can_edit: canAuthorFssai(me),
      today,
      /* The one sentence a reader needs so the screen does not over-promise. */
      arming: 'A late action is chased the first time somebody opens the corrective-action queue each day, '
        + 'and whenever a manager presses “Chase now”. There is no fixed-time job on the server for this yet.',
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
