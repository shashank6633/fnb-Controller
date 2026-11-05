/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';
import {
  FSSAI_SIGNATURE_STATEMENT, fssaiSignatureStatement,
} from '@/lib/fssai';
import {
  requireFssaiUser, fssaiCsrfGuard, fssaiAudit, fssaiAppAudit, str,
  canSeeFssaiRun, fssaiAnswerComplete, fssaiEvidenceCountsByQuestion,
  fssaiSignatureState, signFssaiRun,
  FSSAI_UNSIGN_ACTION,
} from '@/lib/fssai-server';

/**
 * SIGNING A CHECK (/api/fssai/sign) — P3.
 *
 * WHY THIS ROUTE EXISTS AT ALL, when `fssai_runs.signed_by` was already being
 * filled in. P2a's submit wrote the submitter's own email into `signed_by` as a
 * SIDE EFFECT of submitting, whenever the checklist had `requires_signature`. So
 * every record carried a signature that no human being was ever asked for. That
 * is worse than having none: an inspector reading "signed by chef@akan" would
 * reasonably believe somebody attested to those readings, when in fact the server
 * wrote the line by itself the moment the last box was ticked. A signature nobody
 * performed cannot be repudiated because there is nothing to repudiate.
 *
 * So signing is now a DELIBERATE ACT, and submit refuses without it (see
 * api/fssai/runs/route.ts, the `signature_required` / `signature_stale` gate).
 *
 *   GET    ?run_id=<id>  → is it signed, by whom, when, does the signature still
 *                          cover the sheet, and what is still unanswered.
 *   POST   { run_id, statement? }
 *                        → sign. Records WHO (from the session cookie, never from
 *                          the body), WHEN (the server clock, never the phone's),
 *                          WHAT (a SHA-256 of every answer and photograph as they
 *                          stand) and the STATEMENT in words.
 *   DELETE ?run_id=<id>[&reason=]
 *                        → withdraw it while the check is still open. The
 *                          withdrawal is a row of its own: both acts stay in the
 *                          file (owner §19 — void, never delete).
 *
 * WHAT A SIGNATURE HERE PROVES, AND WHAT IT DOES NOT — the full four-point list
 * is at src/lib/fssai.ts §11 and it is shown to the person on screen before they
 * press the button. In short: it proves which ACCOUNT attested, and that nothing
 * has been changed THROUGH THIS APP since. It does not prove who was holding the
 * phone, it is not a cryptographic signature over tamper-proof storage, it is not
 * a handwritten mark, and it does not make the reading true.
 *
 * §7 Q6 is a PROVISIONAL DEFAULT (authenticated user + timestamp, no drawing).
 * The owner has not ruled. If he wants a drawn mark, `fssai_evidence.kind` has a
 * 'signature' value waiting and this route is where it would be written — the
 * screens would not have to change shape.
 */
export const dynamic = 'force-dynamic';

/** Everything both GET and POST say about one run, computed once. */
function signatureView(db: any, runId: string, templateId: string) {
  const state = fssaiSignatureState(db, runId);
  const responses = db.prepare(`SELECT * FROM fssai_responses WHERE run_id = ?`).all(runId) as any[];
  const byQ = new Map(responses.map((r: any) => [String(r.question_id), r]));
  const ev = fssaiEvidenceCountsByQuestion(db, runId);
  const liveQs = db.prepare(
    `SELECT id, prompt, is_required, allow_na, qtype, photo_rule, note_rule
       FROM fssai_questions WHERE template_id = ? AND is_active = 1 ORDER BY sort_order ASC`,
  ).all(templateId) as any[];

  /* What is still missing, said the same way submit will say it — the same
   * predicate, so "ready to sign" and "ready to submit" can never disagree. */
  const outstanding = liveQs
    .map((q: any) => ({ q, state: fssaiAnswerComplete(q, byQ.get(String(q.id)), ev.get(String(q.id)) || 0) }))
    .filter(({ q, state: s }: any) => Number(q.is_required) && !s.answered)
    .map(({ q, state: s }: any) => ({ question_id: String(q.id), prompt: String(q.prompt ?? ''), reason: s.reason }));

  return {
    ...state,
    statement_to_show: FSSAI_SIGNATURE_STATEMENT,
    outstanding,
    is_ready: outstanding.length === 0,
  };
}

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;
  try {
    const db = getDb();
    const runId = str(new URL(request.url).searchParams.get('run_id'));
    if (!runId) return Response.json({ error: 'Which check? No id was sent.' }, { status: 400 });
    const run = db.prepare(`SELECT * FROM fssai_runs WHERE id = ?`).get(runId) as any;
    if (!run) return Response.json({ error: 'That check no longer exists.' }, { status: 404 });
    if (!canSeeFssaiRun(me, run)) {
      return Response.json({ error: 'That check belongs to another department.' }, { status: 403 });
    }
    return Response.json({
      run_id: runId,
      status: run.status,
      recorded_by: run.recorded_by,
      recorded_name: run.recorded_name,
      // Whose act it would be. Only the person holding the check may sign it.
      can_sign: run.status === 'in_progress'
        && String(run.recorded_by || '').toLowerCase() === String(me.email || '').toLowerCase(),
      ...signatureView(db, runId, run.template_id),
    });
  } catch (e: any) {
    console.error('GET /api/fssai/sign failed:', e);
    return Response.json({ error: e?.message || 'Failed to read the signature' }, { status: 500 });
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
    const runId = str(body?.run_id);
    if (!runId) return Response.json({ error: 'Which check? No id was sent.' }, { status: 400 });

    const run = db.prepare(`SELECT * FROM fssai_runs WHERE id = ?`).get(runId) as any;
    if (!run) return Response.json({ error: 'That check no longer exists.' }, { status: 404 });

    /* A finished record is not re-signed. Owner §19: it is voided with a reason,
     * never edited — and re-signing a submitted record would change what the
     * attestation covers after the fact, which is the one thing this route
     * exists to make impossible. */
    if (run.status !== 'in_progress') {
      return Response.json(
        { error: 'That check has already been submitted, so its signature is part of the record now.' },
        { status: 409 },
      );
    }
    /* THE PERSON WHO DID THE WORK SIGNS IT. Not a colleague, not a manager — a
     * manager who needs to finish somebody's round takes it over first
     * (action:'takeover'), which is recorded with a reason. */
    if (String(run.recorded_by || '').toLowerCase() !== String(me.email || '').toLowerCase()) {
      return Response.json(
        {
          error: `This check is open in ${run.recorded_name || run.recorded_by}'s name, so only they can sign it. A manager can hand it over first.`,
          code: 'not_yours',
        },
        { status: 403 },
      );
    }

    const statement = fssaiSignatureStatement(str(body?.statement));

    /* ONE implementation of the act, shared with the submit route's one-tap
     * "Sign and submit" (signFssaiRun) — so a signature written here and a
     * signature written there carry the same digest, the same statement and the
     * same audit row, and cannot drift apart. */
    let signature!: ReturnType<typeof signFssaiRun>;
    const sign = db.transaction(() => {
      const open = db.prepare(`SELECT status FROM fssai_runs WHERE id = ?`).get(runId) as any;
      if (!open || open.status !== 'in_progress') throw new Error('FSSAI_RUN_NOT_OPEN');
      signature = signFssaiRun(db, runId, run, { email: me.email, name: me.name }, statement, outletId);
    });
    try { sign(); } catch (e: any) {
      if (String(e?.message) === 'FSSAI_RUN_NOT_OPEN') {
        return Response.json({ error: 'That check is no longer open.' }, { status: 409 });
      }
      throw e;
    }
    const signedAt = signature.signed_at;
    const digest = signature.sheet_digest;
    fssaiAppAudit(db, {
      event_type: 'fssai.run.sign', entity_type: 'fssai_runs', entity_id: runId,
      actor_email: me.email, after: { signed_at: signedAt, sheet_digest: digest }, note: statement,
    });

    const view = signatureView(db, runId, run.template_id);
    return Response.json({
      ok: true,
      ...view,
      // LAST, so it wins over the copy `view` read back out of the audit row: this
      // is the signature this request actually wrote, whatever a best-effort log
      // row managed to store (§7 Q4).
      signature,
      // Said out loud rather than left for the person to discover at submit.
      ...(view.is_ready
        ? {}
        : {
          warning: `You have signed, but ${view.outstanding.length} question${view.outstanding.length === 1 ? '' : 's'} still need${view.outstanding.length === 1 ? 's' : ''} an answer. Answering one now will ask you to sign again, because your signature covers the answers as they were when you signed.`,
        }),
    });
  } catch (e: any) {
    console.error('POST /api/fssai/sign failed:', e);
    return Response.json({ error: e?.message || 'Failed to record the signature' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  try {
    const db = getDb();
    const url = new URL(request.url);
    const runId = str(url.searchParams.get('run_id'));
    if (!runId) return Response.json({ error: 'Which check? No id was sent.' }, { status: 400 });
    const run = db.prepare(`SELECT * FROM fssai_runs WHERE id = ?`).get(runId) as any;
    if (!run) return Response.json({ error: 'That check no longer exists.' }, { status: 404 });
    if (run.status !== 'in_progress') {
      return Response.json(
        { error: 'That check has been submitted. Its signature is part of the record — a manager can void the whole record if it was a mistake.' },
        { status: 409 },
      );
    }
    if (String(run.recorded_by || '').toLowerCase() !== String(me.email || '').toLowerCase()) {
      return Response.json({ error: 'Only the person who signed can take their signature back.' }, { status: 403 });
    }
    const state = fssaiSignatureState(db, runId);
    if (!state.is_signed) {
      return Response.json({ error: 'This check is not signed, so there is nothing to take back.' }, { status: 409 });
    }
    const reason = str(url.searchParams.get('reason')) || 'Withdrawn while the check was still open';

    const unsign = db.transaction(() => {
      db.prepare(
        `UPDATE fssai_runs SET signed_by='', signed_at='', updated_at=datetime('now')
          WHERE id=? AND status='in_progress'`,
      ).run(runId);
      /* fssaiAudit (which THROWS) on purpose, unlike the sign act: withdrawing an
       * attestation is the one move here that removes something from the file, so
       * it is rolled back rather than applied unrecorded. The sign row it
       * supersedes is left exactly where it is. */
      fssaiAudit(db, {
        entity_table: 'fssai_runs', entity_id: runId, action: FSSAI_UNSIGN_ACTION, field: 'signed_by',
        before: state.signature, after: { signed_by: '', signed_at: '' },
        reason,
        actor: { email: me.email, name: me.name }, outlet_id: run.outlet_id,
      });
    });
    unsign();
    fssaiAppAudit(db, {
      event_type: 'fssai.run.unsign', entity_type: 'fssai_runs', entity_id: runId,
      actor_email: me.email, before: { signed_at: state.signature?.signed_at || '' }, note: reason,
    });

    return Response.json({ ok: true, withdrawn: true, ...signatureView(db, runId, run.template_id) });
  } catch (e: any) {
    console.error('DELETE /api/fssai/sign failed:', e);
    return Response.json({ error: e?.message || 'Failed to withdraw the signature' }, { status: 500 });
  }
}
