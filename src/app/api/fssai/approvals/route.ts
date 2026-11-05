/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import {
  canVerifyFssai, fssaiVerifyRefusal, fssaiRunStatusMeta,
  FSSAI_VERIFY_WRITABLE_RUN_COLUMNS,
  type FssaiApprovalDecision,
} from '@/lib/fssai';
import {
  requireFssaiUser, fssaiCsrfGuard, fssaiAudit, fssaiAppAudit, str,
  canSeeFssaiRun, readFssaiRecordSnapshot, readFssaiSignature, computeFssaiSheetDigest,
  readFssaiCorrectiveActions,
} from '@/lib/fssai-server';

/**
 * THE VERIFICATION QUEUE (/api/fssai/approvals) — P3.
 *
 * A supervisor reads a submitted record and either VERIFIES it or SENDS IT BACK.
 *
 * ── THE ONE RULE THAT MAKES A REGISTER A REGISTER ────────────────────────────
 * VERIFYING MAY NOT CHANGE WHAT THE RECORD SAYS. Not a reading, not a verdict,
 * not a photograph, not the signature. A file whose history can be edited by the
 * person reviewing it is not evidence of anything, and "there is no button for
 * it" is not a guarantee — a route that accepts a field will eventually be sent
 * that field.
 *
 * So this route is built so that it CANNOT:
 *   · the UPDATE is generated from FSSAI_VERIFY_WRITABLE_RUN_COLUMNS
 *     (['status','updated_at']) rather than written out by hand, so the set of
 *     writable columns is one exported list that a test can assert on;
 *   · it holds no INSERT or UPDATE against fssai_responses or fssai_evidence at
 *     all — grep this file: there is none;
 *   · the request body is read for exactly three fields (run_id, decision, note).
 *     Anything else a caller sends is ignored, and the P3 proofs POST a body
 *     stuffed with value_text/value_num/is_fail/pass_pct and then re-read the
 *     answers to show they did not move.
 *
 * ── WHO ─────────────────────────────────────────────────────────────────────
 * §7 Q3 (PROVISIONAL DEFAULT — the owner has not ruled): any management may
 * verify, but NEVER the person who recorded it. Both halves live in
 * fssaiVerifyRefusal so the screen and the route give the same answer in the same
 * words. The second half is the one with teeth: a manager who runs a check
 * himself cannot then verify his own work, and the refusal says so plainly.
 *
 * ── SENDING ONE BACK ────────────────────────────────────────────────────────
 * A rejection needs a written reason — it is the one decision that tells a member
 * of staff their work was not accepted, and "rejected" with no note is how a
 * compliance file becomes an argument. `rejected` does NOT close the slot
 * (runs/route.ts:158), so a fresh check can be recorded for the same round; the
 * rejected record stays in the file (owner §19 — nothing is deleted).
 *
 *   GET  ?queue=1[&status=&department_id=&from=&to=&q=]   the list to work through
 *   GET  ?run_id=<id>                                    one record, everything on it
 *   POST { run_id, decision:'verified'|'rejected', note } the decision
 */
export const dynamic = 'force-dynamic';

const QUEUE_LIMIT = 200;

/** The shape both the queue and the record view use for a run row. */
function runRow(r: any) {
  const meta = fssaiRunStatusMeta(String(r.status || ''));
  return {
    id: r.id,
    template_id: r.template_id,
    template_name: r.template_name ?? '',
    template_code: r.template_code ?? '',
    // Lead with the name the record was TAKEN under, never the live one (the P2a
    // contract: a rename must not re-label history).
    template_name_at_record: r.template_name_at_record ?? r.template_name ?? '',
    template_version: Number(r.template_version) || 0,
    business_date: r.business_date,
    shift: r.shift ?? '',
    target_kind: r.target_kind ?? 'none',
    target_label: r.target_label ?? '',
    department_id: r.department_id ?? '',
    department_name: r.department_name ?? '',
    status: r.status,
    status_label: meta?.label ?? String(r.status || ''),
    submitted_at: r.submitted_at ?? '',
    recorded_by: r.recorded_by ?? '',
    recorded_name: r.recorded_name ?? '',
    signed_by: r.signed_by ?? '',
    signed_at: r.signed_at ?? '',
    total_count: Number(r.total_count) || 0,
    answered_count: Number(r.answered_count) || 0,
    fail_count: Number(r.fail_count) || 0,
    na_count: Number(r.na_count) || 0,
    pass_pct: Number(r.pass_pct) || 0,
    outcome: r.outcome ?? '',
    remarks: r.remarks ?? '',
    is_backdated: Number(r.is_backdated) ? 1 : 0,
    backdate_reason: r.backdate_reason ?? '',
  };
}

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  try {
    const db = getDb();
    const url = new URL(request.url);
    const runId = str(url.searchParams.get('run_id'));

    /* ══ ONE RECORD — everything a reviewer needs to decide ═════════════════ */
    if (runId) {
      const run = db.prepare(
        `SELECT r.*, t.name AS template_name, t.code AS template_code,
                t.requires_verification, t.pass_threshold_pct,
                d.name AS department_name
           FROM fssai_runs r
           LEFT JOIN fssai_templates t ON t.id = r.template_id
           LEFT JOIN departments d     ON d.id = r.department_id
          WHERE r.id = ?`,
      ).get(runId) as any;
      if (!run) return Response.json({ error: 'That check no longer exists.' }, { status: 404 });
      // Reading a record obeys the ordinary run-visibility rule; DECIDING on it
      // is the stricter test below.
      if (!canSeeFssaiRun(me, run)) {
        return Response.json({ error: 'That check belongs to another department.' }, { status: 403 });
      }

      const snapshot = readFssaiRecordSnapshot(db, runId);
      const responses = db.prepare(
        `SELECT * FROM fssai_responses WHERE run_id = ? ORDER BY sort_order ASC, created_at ASC`,
      ).all(runId) as any[];
      // Metadata only. The images are fetched one at a time from
      // /api/fssai/evidence?id=… so opening a record with six photographs on a
      // phone does not cost megabytes.
      const evidence = db.prepare(
        `SELECT e.id, e.response_id, e.kind, e.filename, e.mime, e.size_bytes, e.caption,
                e.created_by, e.created_at, r.question_id AS question_id
           FROM fssai_evidence e LEFT JOIN fssai_responses r ON r.id = e.response_id
          WHERE e.run_id = ? ORDER BY e.created_at ASC`,
      ).all(runId) as any[];
      const approvals = db.prepare(
        `SELECT id, decision, decided_by, decided_at, note FROM fssai_approvals
          WHERE run_id = ? ORDER BY decided_at ASC, rowid ASC`,
      ).all(runId) as any[];

      const signature = snapshot?.signature ?? readFssaiSignature(db, runId);
      /* DOES THE ATTESTATION STILL COVER THIS RECORD? Recomputed here, on read,
       * over the record's own rows — the one place recomputation is right,
       * because it is not re-judging anything, it is checking that nobody has. */
      const digestNow = computeFssaiSheetDigest(db, runId);
      const refusal = fssaiVerifyRefusal(me, run);

      return Response.json({
        run: runRow({ ...run, template_name_at_record: snapshot?.template?.name ?? run.template_name }),
        template_as_recorded: snapshot?.template ?? null,
        template_name_source: snapshot?.template?.name ? 'record' : 'live',
        sheet_as_asked: snapshot?.sheet ?? [],
        responses,
        evidence,
        approvals,
        signature,
        signature_intact: signature ? signature.sheet_digest === digestNow.digest : null,
        /* THE FOLLOW-UP, ON THE RECORD ITSELF (owner Q14). A supervisor deciding
         * whether to verify a FAILED check needs to see what was raised against
         * it and whether it has been fixed — that is the question an inspector
         * asks about a failure, more than the failure itself. Read-only here:
         * this route writes nothing to fssai_corrective_actions, and verifying a
         * record neither closes nor alters an action hanging off it. */
        corrective_actions: readFssaiCorrectiveActions(db, runId),
        requires_verification: Number(run.requires_verification) ? 1 : 0,
        // '' means this person may decide. Anything else is the sentence to show.
        can_verify: refusal === '',
        verify_refusal: refusal,
        // Stated on the record view itself, so nobody has to take it on trust.
        cannot_change: 'Verifying a record cannot change what it says. This screen can only add a decision to it.',
      });
    }

    /* ══ THE QUEUE ══════════════════════════════════════════════════════════ *
     * Management only. §7 Q10: a member of staff sees their own department's
     * records; the cross-department review list is a management surface, and
     * verifying is a management act in the first place (§7 Q3). */
    if (!isManagement(me)) {
      return Response.json(
        { error: 'Only a manager or an administrator can open the verification list.' },
        { status: 403 },
      );
    }

    const status = str(url.searchParams.get('status')) || 'submitted';
    const deptId = str(url.searchParams.get('department_id'));
    const from = str(url.searchParams.get('from'));
    const to = str(url.searchParams.get('to'));
    const q = str(url.searchParams.get('q')).toLowerCase();

    const where: string[] = [];
    const args: any[] = [];
    if (status && status !== 'all') {
      where.push(`r.status = ?`);
      args.push(status);
    } else {
      // "All" still means DECIDED records, never an open one: there is nothing to
      // verify on a check somebody is still filling in.
      where.push(`r.status IN ('submitted','verified','rejected')`);
    }
    if (deptId) {
      where.push(`r.department_id = ?`);
      args.push(deptId === '__none__' ? '' : deptId);
    }
    if (from) { where.push(`r.business_date >= ?`); args.push(from); }
    if (to) { where.push(`r.business_date <= ?`); args.push(to); }

    const rows = db.prepare(
      `SELECT r.*, t.name AS template_name, t.code AS template_code, t.requires_verification,
              d.name AS department_name,
              (SELECT json_extract(a.after_json, '$.template.name') FROM fssai_audit_log a
                WHERE a.entity_table='fssai_runs' AND a.entity_id=r.id AND a.action='snapshot'
                ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1) AS template_name_at_record,
              (SELECT COUNT(*) FROM fssai_evidence e WHERE e.run_id = r.id) AS photo_count
         FROM fssai_runs r
         LEFT JOIN fssai_templates t ON t.id = r.template_id
         LEFT JOIN departments d     ON d.id = r.department_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.submitted_at DESC, r.business_date DESC
        LIMIT ${QUEUE_LIMIT}`,
    ).all(...args) as any[];

    const shaped = rows
      .map((r) => ({
        ...runRow(r),
        photo_count: Number(r.photo_count) || 0,
        requires_verification: Number(r.requires_verification) ? 1 : 0,
        /* Why THIS reviewer cannot decide THIS row — computed per row, because the
         * commonest case is a manager looking at a check he recorded himself. The
         * queue shows it rather than hiding the row: hiding it would look like the
         * record had vanished. */
        verify_refusal: fssaiVerifyRefusal(me, r),
        can_verify: canVerifyFssai(me, r.recorded_by) && String(r.status) === 'submitted',
      }))
      .filter((r) => !q
        || r.template_name_at_record.toLowerCase().includes(q)
        || r.template_name.toLowerCase().includes(q)
        || r.target_label.toLowerCase().includes(q)
        || r.recorded_name.toLowerCase().includes(q)
        || r.recorded_by.toLowerCase().includes(q));

    const counts = db.prepare(
      `SELECT status, COUNT(*) AS n FROM fssai_runs
        WHERE status IN ('submitted','verified','rejected') GROUP BY status`,
    ).all() as any[];

    return Response.json({
      runs: shaped,
      counts: {
        submitted: Number(counts.find((c) => c.status === 'submitted')?.n) || 0,
        verified: Number(counts.find((c) => c.status === 'verified')?.n) || 0,
        rejected: Number(counts.find((c) => c.status === 'rejected')?.n) || 0,
      },
      // So the screen can name the rule rather than guess at it.
      writable_columns: FSSAI_VERIFY_WRITABLE_RUN_COLUMNS,
      truncated: rows.length >= QUEUE_LIMIT,
    });
  } catch (e: any) {
    console.error('GET /api/fssai/approvals failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the records to verify' }, { status: 500 });
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

    /* EXACTLY THREE FIELDS ARE READ FROM THE BODY. Everything else a caller
     * sends — value_text, is_fail, pass_pct, signed_by — is not read here and
     * therefore cannot be written anywhere. */
    const runId = str(body?.run_id);
    const decision = str(body?.decision) as FssaiApprovalDecision;
    const note = str(body?.note).slice(0, 2000);

    if (!runId) return Response.json({ error: 'Which check? No id was sent.' }, { status: 400 });
    if (decision !== 'verified' && decision !== 'rejected') {
      return Response.json(
        { error: `A decision has to be either "verified" or "rejected" (this said "${decision || 'nothing'}").` },
        { status: 400 },
      );
    }

    const run = db.prepare(`SELECT * FROM fssai_runs WHERE id = ?`).get(runId) as any;
    if (!run) return Response.json({ error: 'That check no longer exists.' }, { status: 404 });

    /* WHO MAY DECIDE — one predicate, shared with the screen and with the GET
     * above, including §7 Q3's "never the person who recorded it". */
    const refusal = fssaiVerifyRefusal(me, run);
    if (refusal) {
      const own = String(me.email || '').toLowerCase() === String(run.recorded_by || '').toLowerCase();
      return Response.json(
        { error: refusal, code: own ? 'own_record' : 'not_allowed' },
        { status: own || !canVerifyFssai(me, run.recorded_by) ? 403 : 409 },
      );
    }

    /* SENDING A RECORD BACK NEEDS A WRITTEN REASON. Verifying does not — a
     * signature of approval is the note. */
    if (decision === 'rejected' && !note) {
      return Response.json(
        {
          error: 'Say why you are sending this check back. The person who recorded it will see this, and a record sent back with no reason cannot be acted on.',
          code: 'reason_required',
        },
        { status: 400 },
      );
    }

    const approvalId = generateId();
    const nextStatus = decision === 'verified' ? 'verified' : 'rejected';

    /* THE UPDATE IS BUILT FROM THE EXPORTED LIST, NOT TYPED OUT.
     * FSSAI_VERIFY_WRITABLE_RUN_COLUMNS is ['status','updated_at']; `status` takes
     * the bound value and `updated_at` takes the clock. If anybody ever adds a
     * column to that list they are editing a line that says out loud what it is
     * for, and the assertion in the P3 proofs reads the same list. */
    const setSql = FSSAI_VERIFY_WRITABLE_RUN_COLUMNS
      .map((c) => (c === 'updated_at' ? `updated_at=datetime('now')` : `${c}=?`))
      .join(', ');
    const setArgs = FSSAI_VERIFY_WRITABLE_RUN_COLUMNS
      .filter((c) => c !== 'updated_at')
      .map((c) => (c === 'status' ? nextStatus : null));

    const decide = db.transaction(() => {
      const res = db.prepare(
        // Status-guarded: two supervisors pressing Verify at the same moment
        // leaves one decision, not two.
        `UPDATE fssai_runs SET ${setSql} WHERE id=? AND status='submitted'`,
      ).run(...setArgs, runId);
      if (res.changes !== 1) throw new Error('FSSAI_RUN_NOT_SUBMITTED');

      db.prepare(
        `INSERT INTO fssai_approvals (id, run_id, decision, decided_by, note, outlet_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(approvalId, runId, decision, me.email || '', note, outletId || run.outlet_id || '');

      /* fssaiAudit THROWS, deliberately (not best-effort): a decision that cannot
       * be recorded must not be applied. §7 Q4's "never lose a check" protects
       * work a member of staff DID; this is a supervisor's judgement, and an
       * unrecorded judgement on a compliance record is worse than a retry. */
      fssaiAudit(db, {
        entity_table: 'fssai_runs', entity_id: runId,
        action: decision === 'verified' ? 'verify' : 'reject', field: 'status',
        before: { status: run.status },
        after: { status: nextStatus, decided_by: me.email || '', approval_id: approvalId },
        reason: note,
        actor: { email: me.email, name: me.name }, outlet_id: outletId || run.outlet_id,
      });
    });
    try { decide(); } catch (e: any) {
      if (String(e?.message) === 'FSSAI_RUN_NOT_SUBMITTED') {
        const now = db.prepare(`SELECT status FROM fssai_runs WHERE id = ?`).get(runId) as any;
        return Response.json(
          {
            error: `Somebody has already dealt with this check — it now reads "${now?.status || 'unknown'}".`,
            code: 'already_decided', status: now?.status || '',
          },
          { status: 409 },
        );
      }
      throw e;
    }

    fssaiAppAudit(db, {
      event_type: decision === 'verified' ? 'fssai.run.verify' : 'fssai.run.reject',
      entity_type: 'fssai_runs', entity_id: runId,
      actor_email: me.email, before: { status: run.status }, after: { status: nextStatus }, note,
    });

    const fresh = db.prepare(`SELECT * FROM fssai_runs WHERE id = ?`).get(runId) as any;
    return Response.json({
      ok: true,
      decision,
      run: runRow(fresh),
      approval: db.prepare(
        `SELECT id, decision, decided_by, decided_at, note FROM fssai_approvals WHERE id = ?`,
      ).get(approvalId),
      /* Said in the response, because it is the thing a supervisor most needs to
       * understand about sending one back: the round becomes recordable again,
       * and the rejected record stays in the file beside it. */
      ...(decision === 'rejected'
        ? { slot_reopened: true, note_to_staff: 'This round can be recorded again. The record you sent back stays in the file with your reason on it.' }
        : {}),
      answers_unchanged: true,
    });
  } catch (e: any) {
    console.error('POST /api/fssai/approvals failed:', e);
    return Response.json({ error: e?.message || 'Failed to record the decision' }, { status: 500 });
  }
}

/* No DELETE, and no PUT. A decision is not taken off a record and is never
 * edited — a further decision is added, and fssai_approvals keeps every one of
 * them in order with its author and its note (owner §19: void, never delete). */
