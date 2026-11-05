/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import {
  canManageFssaiCa, fssaiCaCompleteRefusal, fssaiCaVerifyRefusal, fssaiCaIsClosed,
  fssaiCaStatusMeta, fssaiToday, isISODate, isFssaiCaSeverity, isFssaiCaStatus,
  FSSAI_CA_STATUSES, FSSAI_CA_SEVERITIES,
} from '@/lib/fssai';
import {
  requireFssaiUser, fssaiCsrfGuard, fssaiAudit, fssaiAppAudit, str,
  FSSAI_NO_MATCH, FSSAI_CA_SELECT, shapeFssaiCa,
} from '@/lib/fssai-server';
import {
  createFssaiCaTask, readFssaiCaTaskLink, readFssaiCaTaskLinks, readFssaiCaAlertTrail,
  sweepFssaiCaAlerts, readFssaiEscalationRules,
} from '@/lib/fssai-alerts';
import {
  insertClosureFile, voidClosureFile, listClosureFiles, liveClosureCounts, closureSnapshot,
  readClosureFileRow, closureFileResponse, CLOSURE_LIVE_FILES_PER_RECORD,
} from '../_closure/lib';

/**
 * CORRECTIVE ACTIONS (/api/fssai/corrective-actions) — the owner's §7 Q14.
 *
 * A check failed. This is where the fix and the check on the fix live, and it is
 * the ONLY route that writes fssai_corrective_actions after the raise.
 *
 * ── THE RULE THIS ROUTE IS BUILT AROUND ─────────────────────────────────────
 * THE FAILURE STANDS. In the owner's words: "Corrective action against the
 * failed record. The failure STANDS. The fix and its verification hang off it
 * via fssai_corrective_actions. NO change to the slot rule, no 'rejected'
 * status, no voiding a true observation."
 *
 * So, exactly as /api/fssai/approvals cannot edit an answer, this route cannot
 * un-fail anything, and not because there is no button for it:
 *   · it holds NO INSERT or UPDATE against fssai_runs or fssai_responses —
 *     grep this file, there is none. Every write names fssai_corrective_actions;
 *   · it never reads `status`, `outcome`, `pass_pct`, `fail_count` or `is_fail`
 *     out of the request body, so a caller who sends them changes nothing;
 *   · it does not touch the one-run-per-slot rule. A slot closed by a failed
 *     record stays closed however many actions are verified against it.
 * A verified corrective action means the fix was done and somebody checked it.
 * It never means the check passed after all.
 *
 * ── THE STATES, AND THE ONE PAIR THAT MATTERS ───────────────────────────────
 *   open → in_progress → done → verified
 *                  ↘ cancelled (management, written reason, never a delete)
 * 'done' is the person who did the work saying what they did. 'verified' is
 * SOMEBODY ELSE agreeing it was enough — never the fixer, and never the person
 * who recorded the failed check (fssaiCaVerifyRefusal). An action cannot reach
 * 'done' at all without `action_taken` in words: "closed with no note" is how a
 * compliance file becomes a list of ticks.
 *
 *   GET  ?id=<ca>                one action, everything on it
 *   GET  ?run_id=<run>           every action hanging off one record
 *   GET  ?file=<attachment>      one closure photograph's image (same fence as ?id=)
 *   GET  [?status=&severity=&department_id=&owner=&q=&from=&to=&overdue=1]
 *   POST { action: 'assign'|'start'|'complete'|'verify'|'reopen'|'cancel'
 *                 |'create_task'|'attach_closure'|'void_file', id, … }
 *
 * ── CLOSURE PHOTOGRAPHS (Hyderabad audit line #120, 2026-10-14) ─────────────
 * `attach_closure` { id, data_uri, filename?, caption? } puts ONE photograph of
 * the fix on the action (fssai_attachments, purpose 'closure'). While the action
 * is open or being fixed, whoever may record the fix may add one; once the fix
 * is written down ('done'), only management may — the checker's own photograph
 * — because the fixer's statement is frozen until it is sent back. A verified or
 * cancelled action is closed evidence: nothing is added, nothing is voided.
 * `void_file` { id, attachment_id, reason } VOIDS a photograph taken by mistake:
 * management, a written reason, the row and its image KEPT and shown as void.
 * There is no way to remove one. `complete` and `verify` freeze the live
 * photographs (id + SHA-256) into their audit rows, so what the checker saw is
 * on file however the set changes later. A photograph is never REQUIRED to
 * close — "retrained the line cooks" has nothing to photograph — but `complete`
 * says so in its reply and the screen shows "in words only", and
 * readFssaiVisitClosureEvidence (../_closure/lib.ts) counts such points apart.
 *
 * ── THE TWO THINGS ADDED FOR §21 AND §23, AND WHAT THEY DO NOT DO ───────────
 * `create_task` makes the fix a job in the Task Manager staff already use and
 * writes the task's id into `created_task_id` — the column that, until now,
 * nothing wrote (the raise path left it '' rather than fabricate an id). The
 * task is how a person is ASKED to do the work; this action stays the
 * compliance record. Completing the task does not complete the action, and
 * src/lib/fssai-alerts.ts holds no write against fssai_runs or fssai_responses
 * either, so neither half can un-fail a check.
 *
 * The list GET also rides a THROTTLED chase (src/lib/fssai-alerts.ts), so
 * opening this queue is what tells the owner of a late action that it is late.
 * It is best-effort and ten-minute throttled: a chase that broke the queue
 * would be worse than a chase that missed a morning.
 *
 * NO DELETE and no way to create one by hand. Every action in the file was
 * raised by a real failed answer on a real record (owner §19: nothing is
 * deleted; an action that should not have been raised is CANCELLED with a
 * reason, and the row stays pointing at the check).
 */
export const dynamic = 'force-dynamic';

const LIST_LIMIT = 300;

/**
 * WHICH ACTIONS MAY THIS PERSON SEE? — the same shape as the runs list.
 *
 * Management sees everything. Everybody else sees an action in their own
 * department, one assigned to them, or one raised by a check they recorded
 * themselves. FSSAI_NO_MATCH, never '': a user with no department must see the
 * actions that are HIS, not every action whose department column is blank.
 */
function visibilityClause(me: any): { sql: string; args: any[] } {
  if (isManagement(me)) return { sql: '', args: [] };
  return {
    sql: `(lower(c.owner_email) = lower(?)
           OR (c.department_id <> '' AND c.department_id = ?)
           OR lower(IFNULL(r.recorded_by,'')) = lower(?))`,
    args: [me.email || FSSAI_NO_MATCH, me.department_id || FSSAI_NO_MATCH, me.email || FSSAI_NO_MATCH],
  };
}

/** One action by id, with everything a screen shows, or null. */
function readOne(db: any, id: string) {
  const row = db.prepare(`${FSSAI_CA_SELECT} WHERE c.id = ?`).get(id) as any;
  return row ? { row, shaped: shapeFssaiCa(row) } : null;
}

/** May this person even look at this one? Mirrors visibilityClause. */
function canSeeCa(me: any, row: any): boolean {
  if (isManagement(me)) return true;
  const mine = String(me.email || '').trim().toLowerCase();
  if (mine && String(row.owner_email || '').trim().toLowerCase() === mine) return true;
  if (mine && String(row.run_recorded_by || '').trim().toLowerCase() === mine) return true;
  return !!String(row.department_id || '') && row.department_id === me.department_id;
}

/**
 * MAY THIS PERSON ADD A CLOSURE PHOTOGRAPH TO THIS ACTION NOW? '' when they may.
 * `state` says whether the refusal is about the action (409) or the person (403).
 *
 *  · verified / cancelled — closed evidence. A checker signed the action off
 *    against the photographs that were there; adding one afterwards would change
 *    what was checked. A fault that comes back raises a fresh action.
 *  · done — the fixer's statement is frozen until a manager sends it back (the
 *    same rule fssaiCaCompleteRefusal holds for the words). Management may add
 *    one: the checker photographing what they re-measured is the best closure
 *    evidence there is.
 *  · open / in_progress — whoever may record the fix (fssaiCaCompleteRefusal).
 */
function closureAttachRefusal(me: any, ca: any): { error: string; state: boolean } | null {
  const st = String(ca.status || '');
  if (st === 'verified') {
    return { error: 'This action has been fixed and checked, so its photographs are closed evidence. If the fault comes back, the next failed check raises a fresh action.', state: true };
  }
  if (st === 'cancelled' || st === 'void') {
    return { error: 'This action was cancelled, so nothing more is added to it.', state: true };
  }
  if (st === 'done') {
    return canManageFssaiCa(me)
      ? null
      : { error: 'The fix has been written down and is waiting to be checked. The person checking it can add a photograph; if more is needed, a manager will send it back to you.', state: false };
  }
  const refusal = fssaiCaCompleteRefusal(me, { status: st, owner_email: ca.owner_email });
  return refusal ? { error: refusal, state: false } : null;
}

/** May a photograph on this action still be voided? The ACTION's half of the rule. */
function closureVoidStateRefusal(ca: any): string {
  const st = String(ca.status || '');
  if (st === 'verified') return 'This action has been fixed and checked with these photographs in front of the checker, so they stay exactly as they are.';
  if (st === 'cancelled' || st === 'void') return 'This action was cancelled, so its photographs are closed evidence and stay as they are.';
  return '';
}

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  try {
    const db = getDb();
    const url = new URL(request.url);

    /* ══ ONE CLOSURE PHOTOGRAPH'S IMAGE ═════════════════════════════════════
     * The SAME fence as reading the action: a file is served only when it is
     * on a corrective action this person may see. A file on any other table
     * answers exactly like a missing one. Void files are served too — a void
     * keeps its image; the screen marks it void. */
    const fileId = str(url.searchParams.get('file'));
    if (fileId) {
      const row = readClosureFileRow(db, fileId);
      const owner = row && String(row.entity_table) === 'fssai_corrective_actions' ? readOne(db, String(row.entity_id)) : null;
      if (!row || !owner || !canSeeCa(me, owner.row)) {
        return Response.json({ error: 'That photograph is not on a corrective action you can open.' }, { status: 404 });
      }
      return closureFileResponse(row);
    }

    /* ══ ONE ACTION ═════════════════════════════════════════════════════════ */
    const id = str(url.searchParams.get('id'));
    if (id) {
      const found = readOne(db, id);
      if (!found) return Response.json({ error: 'That corrective action no longer exists.' }, { status: 404 });
      if (!canSeeCa(me, found.row)) {
        return Response.json({ error: 'That corrective action belongs to another department.' }, { status: 403 });
      }
      const attachRefusal = closureAttachRefusal(me, found.row);
      const voidState = closureVoidStateRefusal(found.row);
      return Response.json({
        /* Hyderabad audit line #120 — closure evidence. Live and void, oldest
         * first; the image itself is fetched from each file's `url`. */
        closure_files: listClosureFiles(db, 'fssai_corrective_actions', [id]).get(id) || [],
        closure_rules: {
          // '' = this person may add a photograph now; else the sentence why not.
          attach_refusal: attachRefusal?.error || '',
          // '' = a manager may void a photograph here with a reason; else why not.
          void_refusal: !canManageFssaiCa(me)
            ? 'Only a manager, head of department or administrator can void a photograph.'
            : voidState,
          live_limit: CLOSURE_LIVE_FILES_PER_RECORD,
        },
        action: found.shaped,
        // '' means this person may do it. Anything else is the sentence to show,
        // computed by the SAME predicates the POST re-checks, so the button and
        // the refusal can never disagree.
        complete_refusal: fssaiCaCompleteRefusal(me, {
          status: found.row.status, owner_email: found.row.owner_email,
        }),
        verify_refusal: fssaiCaVerifyRefusal(me, {
          status: found.row.status, completed_by: found.row.completed_by,
          run_recorded_by: found.row.run_recorded_by,
        }),
        can_manage: canManageFssaiCa(me),
        cannot_change: 'A corrective action cannot change the check that failed. The failure stays on the record exactly as it was written.',
        /* §21 — the job in the Task Manager, carried BESIDE the shaped action
         * rather than inside it: FssaiCaView lives in src/lib/fssai.ts, which
         * this lane may not edit, and a second private shape of the same row is
         * exactly how two screens end up disagreeing. */
        task: readFssaiCaTaskLink(db, found.row),
        /* §23 — what was actually SENT about this action, read out of the audit
         * trail rather than recomputed, so tightening a rule tomorrow cannot
         * rewrite what somebody was told yesterday. */
        alerts: readFssaiCaAlertTrail(db, id),
      });
    }

    /* ══ EVERY ACTION ON ONE RECORD ═════════════════════════════════════════ */
    const runId = str(url.searchParams.get('run_id'));

    /**
     * ══ THE RIDE-ALONG CHASE (owner §23) ═════════════════════════════════
     *
     * Opening the queue chases whatever is late. This is the same argument the
     * scheduler makes about recording retention and idle tables in its own
     * comments — a policy that only fires when somebody presses a button is not
     * a policy — with one honest difference: this lane may not edit
     * src/lib/scheduler.ts, so a page load is the earliest trigger available.
     * THE SWEEP IS ITS OWN GATE: ten-minute throttled by a settings watermark,
     * `INSERT OR IGNORE` deduped per action per day, and it swallows its own
     * errors. ?no_sweep=1 turns it off for a caller that just wants the rows.
     *
     * It is not run for a single-record read (?run_id=) because that is opened
     * from a record page, where chasing is not the reader's job.
     */
    if (!runId && url.searchParams.get('no_sweep') !== '1') {
      try {
        if (readFssaiEscalationRules(db).enabled) sweepFssaiCaAlerts(db);
      } catch (sweepErr) {
        // Never let the chase break the queue it is chasing.
        console.error('[fssai] ride-along chase failed (the list is unaffected):', sweepErr);
      }
    }

    /* ══ THE LIST ═══════════════════════════════════════════════════════════ */
    const where: string[] = [];
    const args: any[] = [];
    if (runId) { where.push('c.run_id = ?'); args.push(runId); }

    const status = str(url.searchParams.get('status')) || 'outstanding';
    if (status === 'outstanding') {
      // The default, and the only one a person working through the list wants:
      // everything that still needs somebody to do something.
      where.push(`c.status IN ('open','in_progress','done')`);
    } else if (status !== 'all') {
      if (!isFssaiCaStatus(status)) {
        return Response.json({ error: `"${status}" is not a state a corrective action can be in.` }, { status: 400 });
      }
      where.push('c.status = ?');
      args.push(status);
    }

    const severity = str(url.searchParams.get('severity'));
    if (severity) {
      if (!isFssaiCaSeverity(severity)) {
        return Response.json({ error: `"${severity}" is not one of the severities.` }, { status: 400 });
      }
      where.push('c.severity = ?');
      args.push(severity);
    }

    const deptId = str(url.searchParams.get('department_id'));
    if (deptId) { where.push('c.department_id = ?'); args.push(deptId === '__none__' ? '' : deptId); }

    const owner = str(url.searchParams.get('owner'));
    if (owner === '__me__') { where.push('lower(c.owner_email) = lower(?)'); args.push(me.email || FSSAI_NO_MATCH); }
    else if (owner === '__none__') { where.push(`c.owner_email = ''`); }
    else if (owner) { where.push('lower(c.owner_email) = lower(?)'); args.push(owner); }

    const from = str(url.searchParams.get('from'));
    const to = str(url.searchParams.get('to'));
    if (from) { where.push(`IFNULL(r.business_date, substr(c.created_at,1,10)) >= ?`); args.push(from); }
    if (to) { where.push(`IFNULL(r.business_date, substr(c.created_at,1,10)) <= ?`); args.push(to); }

    if (url.searchParams.get('overdue') === '1') {
      // LATE means late AND still needing work. A verified action with a due date
      // three days ago is not overdue, it is finished — saying otherwise on a
      // compliance screen makes the whole list untrustworthy.
      where.push(`c.due_date <> '' AND c.due_date < ? AND c.status IN ('open','in_progress','done')`);
      args.push(fssaiToday());
    }

    const vis = visibilityClause(me);
    if (vis.sql) { where.push(vis.sql); args.push(...vis.args); }

    const rows = db.prepare(
      `${FSSAI_CA_SELECT}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY
         /* Worst first, and "worst" is not severity alone: an action that is
          * already late outranks a fresh urgent one, because the late one has
          * already been ignored. Then severity, then oldest. */
         CASE WHEN c.due_date <> '' AND c.due_date < ? AND c.status IN ('open','in_progress','done') THEN 0 ELSE 1 END ASC,
         CASE c.severity WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
         c.created_at ASC, c.rowid ASC
       LIMIT ${LIST_LIMIT}`,
    ).all(...args, fssaiToday()) as any[];

    const q = str(url.searchParams.get('q')).toLowerCase();
    const shaped = rows.map(shapeFssaiCa).filter((a) => !q
      || a.ca_number.toLowerCase().includes(q)
      || a.title.toLowerCase().includes(q)
      || a.description.toLowerCase().includes(q)
      || a.owner_email.toLowerCase().includes(q)
      || (a.run?.template_name || '').toLowerCase().includes(q)
      || (a.run?.target_label || '').toLowerCase().includes(q));

    /* The tab counts are computed over the SAME visibility clause as the list,
     * so a staff member is never shown "12 open" and then a list of 2. */
    const countWhere: string[] = [];
    const countArgs: any[] = [];
    if (runId) { countWhere.push('c.run_id = ?'); countArgs.push(runId); }
    if (vis.sql) { countWhere.push(vis.sql); countArgs.push(...vis.args); }
    const countRows = db.prepare(
      `SELECT c.status AS status, COUNT(*) AS n,
              SUM(CASE WHEN c.due_date <> '' AND c.due_date < ? AND c.status IN ('open','in_progress','done') THEN 1 ELSE 0 END) AS late
         FROM fssai_corrective_actions c
         LEFT JOIN fssai_runs r ON r.id = c.run_id
        ${countWhere.length ? `WHERE ${countWhere.join(' AND ')}` : ''}
        GROUP BY c.status`,
    ).all(fssaiToday(), ...countArgs) as any[];
    const n = (s: string) => Number(countRows.find((c) => c.status === s)?.n) || 0;

    return Response.json({
      actions: shaped,
      counts: {
        open: n('open'),
        in_progress: n('in_progress'),
        done: n('done'),
        verified: n('verified'),
        cancelled: n('cancelled') + n('void'),
        outstanding: n('open') + n('in_progress') + n('done'),
        overdue: countRows.reduce((t, c) => t + (Number(c.late) || 0), 0),
      },
      statuses: FSSAI_CA_STATUSES,
      severities: FSSAI_CA_SEVERITIES,
      can_manage: canManageFssaiCa(me),
      me: me.email || '',
      truncated: rows.length >= LIST_LIMIT,
      /* §21 — which of these are already a job in the Task Manager, keyed by
       * action id. One query for the whole page, and absent means "no job",
       * never a fabricated id. */
      task_links: readFssaiCaTaskLinks(db, shaped.map((a) => a.id)),
      /* Line #120 — live closure photographs per action, keyed by id. Absent
       * means none; one grouped query for the whole page. */
      closure_counts: liveClosureCounts(db, 'fssai_corrective_actions', shaped.map((a) => a.id)),
      /* Management sees whether the chase is armed at all; a screen that offers
       * "Chase now" while chasing is switched off would be lying. */
      chasing_enabled: readFssaiEscalationRules(db).enabled,
    });
  } catch (e: any) {
    console.error('GET /api/fssai/corrective-actions failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the corrective actions' }, { status: 500 });
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

  try {
    const db = getDb();
    const outletId = (await getCurrentOutletId()) || '';
    const action = str(body?.action);
    const id = str(body?.id);
    if (!id) return Response.json({ error: 'Which corrective action? No id was sent.' }, { status: 400 });

    const found = readOne(db, id);
    if (!found) return Response.json({ error: 'That corrective action no longer exists.' }, { status: 404 });
    const ca = found.row;
    if (!canSeeCa(me, ca)) {
      return Response.json({ error: 'That corrective action belongs to another department.' }, { status: 403 });
    }

    /**
     * MOVE THE ACTION AND RECORD WHY, AS ONE THING.
     *
     * TWO PROPERTIES, AND BOTH ARE LOAD-BEARING:
     *
     * 1. THE UPDATE IS ALWAYS STATUS-GUARDED (`WHERE id=? AND status IN (…)`),
     *    so two people pressing the same button at the same moment leave one
     *    move, not two — the pattern from the verification route's
     *    `WHERE id=? AND status='submitted'`.
     *
     * 2. THE MOVE AND ITS AUDIT ROW ARE IN ONE TRANSACTION. fssaiAudit THROWS
     *    on purpose (unlike fssaiAuditBestEffort): every one of these is a
     *    person's judgement about a food-safety failure, and an action that
     *    moved with no trail is worse than a retry. Without the transaction the
     *    UPDATE would already be committed when the audit threw — the state
     *    would have changed, nothing would say who by or why, AND the caller
     *    would be told it failed, which is the worst of the three. §7 Q4's
     *    "never lose a check" protects work a member of staff DID; it does not
     *    extend to a supervisory decision, exactly as the verification route
     *    reasons.
     */
    const apply = (
      sql: string, args: any[], expected: string[],
      audit: { field: string; before: any; after: any; reason: string },
    ) => {
      const tx = db.transaction(() => {
        const res = db.prepare(
          `UPDATE fssai_corrective_actions SET ${sql}, updated_at=datetime('now')
            WHERE id=? AND status IN (${expected.map(() => '?').join(',')})`,
        ).run(...args, id, ...expected);
        if (res.changes !== 1) throw new Error('FSSAI_CA_MOVED');
        fssaiAudit(db, {
          entity_table: 'fssai_corrective_actions', entity_id: id, action: 'update',
          field: audit.field, before: audit.before, after: audit.after, reason: audit.reason,
          actor: { email: me.email, name: me.name }, outlet_id: outletId || ca.outlet_id || '',
        });
      });
      tx();
    };

    const movedResponse = () => {
      const now = db.prepare(`SELECT status FROM fssai_corrective_actions WHERE id = ?`).get(id) as any;
      return Response.json(
        {
          error: `Somebody has already moved this action — it now reads "${fssaiCaStatusMeta(now?.status).label}".`,
          code: 'already_moved', status: now?.status || '',
        },
        { status: 409 },
      );
    };

    /* ══════════════════════════════════════════════════════════════════════
     * ASSIGN — give it an owner, a deadline, a severity, a root cause.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'assign') {
      if (!canManageFssaiCa(me)) {
        return Response.json({ error: 'Only a manager or an administrator can assign a corrective action.' }, { status: 403 });
      }
      if (fssaiCaIsClosed(ca.status)) {
        return Response.json({ error: 'That action is finished, so it cannot be reassigned.' }, { status: 409 });
      }
      const ownerEmail = str(body?.owner_email).toLowerCase();
      const dueDate = str(body?.due_date);
      const severity = str(body?.severity) || String(ca.severity || 'medium');
      const rootCause = str(body?.root_cause).slice(0, 2000);
      if (dueDate && !isISODate(dueDate)) {
        return Response.json({ error: 'That is not a real date.' }, { status: 400 });
      }
      if (!isFssaiCaSeverity(severity)) {
        return Response.json({ error: `"${severity}" is not one of the severities.` }, { status: 400 });
      }
      if (ownerEmail) {
        // An action assigned to an address nobody signs in with is an action
        // nobody will ever do, and it LOOKS assigned on the queue — which is
        // worse than looking unassigned.
        const who = db.prepare(
          `SELECT email FROM users WHERE lower(email) = lower(?) AND is_active = 1`,
        ).get(ownerEmail) as any;
        if (!who) {
          return Response.json(
            { error: `Nobody signs in as "${ownerEmail}". Choose somebody from the list.` },
            { status: 400 },
          );
        }
      }
      try {
        apply(
          `owner_email=?, due_date=?, severity=?, root_cause=?`,
          [ownerEmail, dueDate, severity, rootCause],
          ['open', 'in_progress', 'done'],
          {
            field: 'owner_email',
            before: { owner_email: ca.owner_email, due_date: ca.due_date, severity: ca.severity, root_cause: ca.root_cause },
            after: { owner_email: ownerEmail, due_date: dueDate, severity, root_cause: rootCause },
            reason: str(body?.reason) || 'Assigned',
          },
        );
      } catch (e: any) {
        if (String(e?.message) === 'FSSAI_CA_MOVED') return movedResponse();
        throw e;
      }
      return Response.json({ ok: true, action: readOne(db, id)?.shaped });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * START — somebody has picked it up. A state, not a claim about the fix.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'start') {
      // The STATE test first, so "already moved on" answers 409 rather than the
      // 403 a permission refusal would give. They are different problems and a
      // person can only act on one of them.
      if (String(ca.status) !== 'open') {
        return Response.json(
          { error: `That action already reads "${fssaiCaStatusMeta(ca.status).label}".`, code: 'already_moved' },
          { status: 409 },
        );
      }
      const refusal = fssaiCaCompleteRefusal(me, { status: ca.status, owner_email: ca.owner_email });
      if (refusal) return Response.json({ error: refusal }, { status: 403 });
      try {
        // Picking up an unassigned action puts YOUR name on it — otherwise two
        // people start the same job and neither knows.
        apply(
          `status='in_progress', owner_email=CASE WHEN owner_email='' THEN ? ELSE owner_email END`,
          [me.email || ''],
          ['open'],
          {
            field: 'status',
            before: { status: ca.status },
            after: { status: 'in_progress', owner_email: ca.owner_email || me.email || '' },
            reason: 'Picked up',
          },
        );
      } catch (e: any) {
        if (String(e?.message) === 'FSSAI_CA_MOVED') return movedResponse();
        throw e;
      }
      return Response.json({ ok: true, action: readOne(db, id)?.shaped });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * COMPLETE — what was actually done. IN WORDS, or not at all.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'complete') {
      /* THE STATE TEST FIRST — 'already recorded' is a 409, not a 403. (The
       * shared predicate returns this same sentence, so the screen never offers
       * a button that would land here; this is the backstop, not the gate.) */
      if (String(ca.status) === 'done') {
        return Response.json(
          {
            error: 'The fix has already been written down and is waiting to be checked. A manager can send it back if it was not enough.',
            code: 'already_moved',
          },
          { status: 409 },
        );
      }
      const refusal = fssaiCaCompleteRefusal(me, { status: ca.status, owner_email: ca.owner_email });
      if (refusal) return Response.json({ error: refusal, code: 'not_allowed' }, { status: 403 });
      const actionTaken = str(body?.action_taken).slice(0, 4000);
      if (!actionTaken) {
        /* THE ONE REFUSAL THIS SCREEN EXISTS FOR. An action closed with no note
         * is a tick, and a file of ticks tells an inspector nothing about
         * whether the fault was ever mended. */
        return Response.json(
          {
            error: 'Write down what you actually did before closing this. A corrective action with no note proves nothing to an inspector — and the person checking it has nothing to check.',
            code: 'action_taken_required',
          },
          { status: 400 },
        );
      }
      // What the fixer is putting their name to: the words AND the photographs
      // live on the action right now, frozen by digest (line #120).
      const photosAtCompletion = closureSnapshot(db, 'fssai_corrective_actions', id);
      try {
        apply(
          `status='done', action_taken=?, completed_at=datetime('now'), completed_by=?,
           owner_email=CASE WHEN owner_email='' THEN ? ELSE owner_email END`,
          [actionTaken, me.email || '', me.email || ''],
          ['open', 'in_progress'],
          {
            field: 'status',
            before: { status: ca.status },
            after: { status: 'done', completed_by: me.email || '', closure_photos: photosAtCompletion },
            // The note IS the reason — §19's "reason for change" and the fix
            // itself are one thing here.
            reason: actionTaken,
          },
        );
      } catch (e: any) {
        if (String(e?.message) === 'FSSAI_CA_MOVED') return movedResponse();
        throw e;
      }
      fssaiAppAudit(db, {
        event_type: 'fssai.ca.complete', entity_type: 'fssai_corrective_actions', entity_id: id,
        actor_email: me.email, before: { status: ca.status }, after: { status: 'done' }, note: actionTaken,
      });
      return Response.json({
        ok: true,
        action: readOne(db, id)?.shaped,
        closure_photos: photosAtCompletion.length,
        // Said out loud so nobody thinks recording the fix finished it — and,
        // when it rests on words alone, so nobody thinks a photograph is on it.
        note_to_staff: photosAtCompletion.length
          ? `Recorded, with ${photosAtCompletion.length} photograph${photosAtCompletion.length === 1 ? '' : 's'}. Somebody else still has to check the fix before this action is closed.`
          : 'Recorded, in words only — no photograph is on it. Somebody else still has to check the fix before this action is closed.',
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * VERIFY — somebody else agrees the fix was enough. §7 Q3's rule again.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'verify') {
      const refusal = fssaiCaVerifyRefusal(me, {
        status: ca.status, completed_by: ca.completed_by, run_recorded_by: ca.run_recorded_by,
      });
      if (refusal) {
        const mine = String(me.email || '').toLowerCase();
        const own = mine === String(ca.completed_by || '').toLowerCase()
          || mine === String(ca.run_recorded_by || '').toLowerCase();
        return Response.json(
          { error: refusal, code: own ? 'own_work' : 'not_allowed' },
          { status: own || !canManageFssaiCa(me) ? 403 : 409 },
        );
      }
      const note = str(body?.verify_note).slice(0, 2000);
      // What the checker had in front of them, frozen by digest (line #120).
      const photosAtVerify = closureSnapshot(db, 'fssai_corrective_actions', id);
      try {
        apply(
          `status='verified', verified_by=?, verified_at=datetime('now'), verify_note=?`,
          [me.email || '', note],
          ['done'],
          {
            field: 'status',
            before: { status: 'done', completed_by: ca.completed_by },
            after: { status: 'verified', verified_by: me.email || '', closure_photos: photosAtVerify },
            reason: note || 'Checked and accepted',
          },
        );
      } catch (e: any) {
        if (String(e?.message) === 'FSSAI_CA_MOVED') return movedResponse();
        throw e;
      }
      fssaiAppAudit(db, {
        event_type: 'fssai.ca.verify', entity_type: 'fssai_corrective_actions', entity_id: id,
        actor_email: me.email, before: { status: 'done' }, after: { status: 'verified' }, note,
      });
      return Response.json({
        ok: true,
        action: readOne(db, id)?.shaped,
        /* THE SENTENCE THAT KEEPS THE OWNER'S RULE VISIBLE. Somebody who has just
         * closed a corrective action is exactly the person most likely to assume
         * the failed check is now a pass. */
        record_unchanged: 'The check that failed still reads as it did. This action records that the fault was mended and checked — it does not change the record.',
        closure_photos: photosAtVerify.length,
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * REOPEN — the fix was recorded but it was not enough.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'reopen') {
      if (!canManageFssaiCa(me)) {
        return Response.json({ error: 'Only a manager or an administrator can send a fix back.' }, { status: 403 });
      }
      const reason = str(body?.reason).slice(0, 2000);
      if (!reason) {
        return Response.json(
          { error: 'Say why the fix was not enough. The person who did it will see this.', code: 'reason_required' },
          { status: 400 },
        );
      }
      /* ONLY FROM 'done', NEVER FROM 'verified' — and this is deliberate.
       * A verified action is a supervisor's judgement already in the file, and
       * reopening it would rewrite that judgement. If the fault comes back, the
       * NEXT failed check raises a NEW action against the NEW record, which is
       * the honest sequence: failed, fixed, checked, failed again. */
      if (String(ca.status) !== 'done') {
        return Response.json(
          {
            error: String(ca.status) === 'verified'
              ? 'That action has been checked and closed. If the fault has come back, it will raise a fresh action the next time the check fails — a closed one is not reopened.'
              : 'Nobody has recorded a fix on this action yet, so there is nothing to send back.',
          },
          { status: 409 },
        );
      }
      try {
        // action_taken and completed_by are KEPT. What was tried and by whom is
        // part of the story of this fault, not a draft to be overwritten.
        apply(
          `status='in_progress'`, [], ['done'],
          {
            field: 'status',
            before: { status: 'done', action_taken: ca.action_taken, completed_by: ca.completed_by },
            after: { status: 'in_progress' },
            reason,
          },
        );
      } catch (e: any) {
        if (String(e?.message) === 'FSSAI_CA_MOVED') return movedResponse();
        throw e;
      }
      return Response.json({ ok: true, action: readOne(db, id)?.shaped });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * CANCEL — the only way out that is not a fix. Never a delete (owner §19).
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'cancel') {
      if (!canManageFssaiCa(me)) {
        return Response.json({ error: 'Only a manager or an administrator can cancel a corrective action.' }, { status: 403 });
      }
      const reason = str(body?.reason).slice(0, 2000);
      if (!reason) {
        return Response.json(
          { error: 'A cancelled corrective action must say why. It stays on the failed check either way.', code: 'reason_required' },
          { status: 400 },
        );
      }
      if (String(ca.status) === 'verified') {
        return Response.json({ error: 'That action has been fixed and checked, so there is nothing to cancel.' }, { status: 409 });
      }
      try {
        apply(
          `status='cancelled', voided_at=datetime('now'), voided_by=?, void_reason=?`,
          [me.email || '', reason],
          ['open', 'in_progress', 'done'],
          {
            field: 'status',
            before: { status: ca.status },
            after: { status: 'cancelled', voided_by: me.email || '' },
            reason,
          },
        );
      } catch (e: any) {
        if (String(e?.message) === 'FSSAI_CA_MOVED') return movedResponse();
        throw e;
      }
      fssaiAppAudit(db, {
        event_type: 'fssai.ca.cancel', entity_type: 'fssai_corrective_actions', entity_id: id,
        actor_email: me.email, before: { status: ca.status }, after: { status: 'cancelled' }, note: reason,
      });
      return Response.json({
        ok: true,
        action: readOne(db, id)?.shaped,
        note_to_staff: 'Cancelled. It stays on the failed check with your reason on it — nothing is removed from the file.',
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * CREATE_TASK — make the fix a job in the list staff already use (§21).
     *
     * MANAGEMENT ONLY, and for one reason: this puts a job in somebody else's
     * list and pushes it to their phone. Recording a fix is work anybody who can
     * see the action may do; asking another person to do work is not.
     *
     * It changes NOTHING about the action except `created_task_id`. No status
     * moves, no due date is touched, and the compliance record still has to be
     * completed and checked here — the task cannot do either, and the sentence
     * returned below says so because somebody who has just created a job will
     * otherwise assume it is now handled.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'create_task') {
      if (!canManageFssaiCa(me)) {
        return Response.json(
          { error: 'Only a manager, head of department or administrator can put this in somebody\'s task list.' },
          { status: 403 },
        );
      }
      const assignee = str(body?.assignee_email).toLowerCase();
      if (assignee) {
        const who = db.prepare(
          `SELECT email, name FROM users WHERE lower(email) = lower(?) AND is_active = 1`,
        ).get(assignee) as any;
        if (!who) {
          return Response.json(
            { error: `Nobody signs in as "${assignee}". Choose somebody from the list.` },
            { status: 400 },
          );
        }
      }
      const dueDate = str(body?.due_date);
      if (dueDate && !isISODate(dueDate)) {
        return Response.json({ error: 'That is not a real date.' }, { status: 400 });
      }
      const priority = str(body?.priority);
      if (priority && !isFssaiCaSeverity(priority)) {
        return Response.json({ error: `"${priority}" is not one of the priorities.` }, { status: 400 });
      }
      const res = createFssaiCaTask(db, {
        ca,
        actor: { email: me.email, name: me.name },
        assigneeEmail: assignee,
        assigneeName: assignee
          ? String((db.prepare(`SELECT name FROM users WHERE lower(email) = lower(?)`).get(assignee) as any)?.name || '')
          : '',
        priority,
        dueDate,
        note: str(body?.note).slice(0, 2000),
        outletId,
        origin: 'manual',
      });
      if (res.created) {
        fssaiAppAudit(db, {
          event_type: 'fssai.ca.task_created', entity_type: 'fssai_corrective_actions', entity_id: id,
          actor_email: me.email, after: { task_id: res.task_id }, note: res.message,
        });
      }
      return Response.json(
        {
          ok: res.created,
          created: res.created,
          task: readFssaiCaTaskLink(db, readOne(db, id)?.row || ca),
          action: readOne(db, id)?.shaped,
          note_to_staff: res.message,
          /* THE SAME SENTENCE UNDER `error` TOO, because apiJson() throws on a
           * non-2xx and reads `.error` — without this the screen would show the
           * caller "HTTP 409" instead of the reason nothing was created. */
          ...(res.created ? {} : { error: res.message }),
        },
        // 409 when there is already a job: nothing was created, and a 200 here
        // would have the screen report success for a no-op.
        { status: res.created ? 200 : 409 },
      );
    }

    /* ══════════════════════════════════════════════════════════════════════
     * ATTACH_CLOSURE — one photograph of the fix (Hyderabad audit line #120).
     *
     * ONE FILE PER CALL: production's nginx accepts about 1 MB, and a 400 KB
     * photograph is ~533 KB once base64'd. The screen uploads each picture as
     * it is taken, then the fix is written down with `complete`.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'attach_closure') {
      const refusal = closureAttachRefusal(me, ca);
      if (refusal) {
        return Response.json({ error: refusal.error, code: refusal.state ? 'closed' : 'not_allowed' }, { status: refusal.state ? 409 : 403 });
      }
      const res = insertClosureFile(db, {
        entity_table: 'fssai_corrective_actions',
        entity_id: id,
        data_uri: str(body?.data_uri),
        filename: str(body?.filename),
        caption: str(body?.caption),
        actor: { email: me.email, name: me.name },
        outlet_id: outletId || ca.outlet_id || '',
        reason: `Closure photograph for ${ca.ca_number || 'this corrective action'}`,
      });
      if ('error' in res) return Response.json({ error: res.error, code: res.code }, { status: res.status });
      return Response.json({
        ok: true,
        file: res.file,
        closure_files: listClosureFiles(db, 'fssai_corrective_actions', [id]).get(id) || [],
        note_to_staff: 'Photograph added to this action. It cannot be removed — one taken by mistake is voided by a manager, with a reason, and stays on file marked void.',
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * VOID_FILE — a photograph taken by mistake. VOIDED, never removed.
     * Management + a written reason (fssaiVoidRefusal, inside voidClosureFile);
     * the action itself must still be live (closureVoidStateRefusal).
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'void_file') {
      const stateRefusal = closureVoidStateRefusal(ca);
      if (stateRefusal && canManageFssaiCa(me)) {
        return Response.json({ error: stateRefusal, code: 'closed' }, { status: 409 });
      }
      const res = voidClosureFile(db, {
        attachment_id: str(body?.attachment_id),
        entity_table: 'fssai_corrective_actions',
        entity_id: id,
        reason: str(body?.reason),
        me: me as any,
        outlet_id: outletId || ca.outlet_id || '',
      });
      if ('error' in res) return Response.json({ error: res.error, code: res.code }, { status: res.status });
      return Response.json({
        ok: true,
        file: res.file,
        closure_files: listClosureFiles(db, 'fssai_corrective_actions', [id]).get(id) || [],
        note_to_staff: 'Voided. The photograph stays on the action, marked void with your reason — nothing was removed.',
      });
    }

    return Response.json(
      {
        error: `"${action || 'nothing'}" is not something that can be done to a corrective action. Use assign, start, complete, verify, reopen, cancel, create_task, attach_closure or void_file.`,
      },
      { status: 400 },
    );
  } catch (e: any) {
    console.error('POST /api/fssai/corrective-actions failed:', e);
    return Response.json({ error: e?.message || 'Failed to record that' }, { status: 500 });
  }
}

/* No DELETE. An action that should never have been raised is CANCELLED with a
 * written reason and stays in the file, pointing at the check that raised it
 * (owner §19). A file you can take rows out of is not a compliance file. */
