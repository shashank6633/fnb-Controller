/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';
import {
  evaluateFssaiAnswer, qtypeMeta,
  FSSAI_EVIDENCE_MAX_PER_ANSWER, FSSAI_EVIDENCE_MAX_PER_RUN,
  FSSAI_PHOTO_MAX_BYTES, FSSAI_PHOTO_TARGET_BYTES, FSSAI_PHOTO_MIMES,
  fssaiBytesLabel, parseFssaiDataUri,
} from '@/lib/fssai';
import {
  requireFssaiUser, fssaiCsrfGuard, fssaiAudit, fssaiAuditBestEffort, fssaiAppAudit,
  parseJsonArray, str, canSeeFssaiRun, fssaiEvidenceCountsByQuestion, fssaiAnswerComplete,
  recomputeFssaiAnsweredCount,
} from '@/lib/fssai-server';

/**
 * THE PHOTOGRAPH ON A CHECK (/api/fssai/evidence) — P3.
 *
 * WHY THIS ROUTE HAD TO EXIST BEFORE THE RUNNER COULD BE HONEST. P2a's fix round
 * made the admin's "required evidence" setting real: a question marked
 * "Photo: Always" is INCOMPLETE until a photograph is attached, and the submit
 * refusal names what it is waiting for. But P2 shipped no way to attach one — the
 * probe had to INSERT the fssai_evidence row by hand to prove submit then
 * succeeded. So "Photo: Always" was unsatisfiable in the running app. This route
 * is that missing half.
 *
 * GET    ?run_id=<id>   → every attachment on the run, WITHOUT the image data
 *                         (id, question_id, kind, filename, mime, size_bytes,
 *                         caption, created_by, created_at). A round with four
 *                         photographs must not cost a megabyte to reopen on a
 *                         phone, so the bytes are fetched one at a time, on tap.
 *        ?id=<evidence> → that one attachment, WITH data_uri.
 * POST   { run_id, question_id | response_id, data_uri, filename?, caption? }
 *                       → attaches a photograph to ONE ANSWER and re-judges that
 *                         answer, because the photograph may be the thing that
 *                         completes it.
 * DELETE ?id=<evidence>[&reason=]
 *                       → only while the check is still open, and only the person
 *                         holding it. A submitted record's photograph is part of
 *                         the record (owner §19).
 *
 * ── THE FOUR RULES THIS ROUTE ENFORCES ───────────────────────────────────────
 * 1. AN ATTACHMENT BELONGS TO AN ANSWER THAT ALREADY EXISTS. fssai_evidence
 *    .response_id points at the answer row, so the answer must be written first.
 *    A request naming a question with no answer yet is refused with
 *    `code:'answer_first'` — a machine-readable 409 the runner handles by writing
 *    the (possibly empty) answer and retrying once, rather than a dead end.
 * 2. ONLY THE PERSON HOLDING THE CHECK MAY ATTACH. Exactly the answer route's
 *    rule (runs/route.ts:451), and for the same reason: two people writing into
 *    one round leaves one record nobody signed. A manager takes it over first.
 * 3. THE ANSWER IS RE-JUDGED INSIDE THE SAME TRANSACTION. A photo question whose
 *    photograph was missing was frozen is_fail=1 ("No photograph attached") — if
 *    attaching the photograph did not re-judge it, the finished record would
 *    print a FAILURE beside the photograph that satisfies it. is_fail is
 *    re-frozen here, at WRITE time, by the same evaluator the answer route uses.
 *    It is still never recomputed on READ (RECON §10 R3).
 * 4. SIZE IS CAPPED, AND THE CAP IS THE ONE PRODUCTION ACTUALLY HAS.
 *    HARD RULE 14: nginx `client_max_body_size` is 1 MB, and a larger upload
 *    returns a bare 413 that no error handler in this app turns into a sentence.
 *    So: a data URI over FSSAI_PHOTO_MAX_BYTES is refused HERE, in words, well
 *    inside that limit, and the runner compresses to ~250 KB before it ever
 *    posts (§7 Q13 — photographs live in-row as TEXT, which is what every other
 *    image store in this app does; a retention window is still the owner's call).
 */
export const dynamic = 'force-dynamic';

/**
 * EVERY LIMIT ON THIS ROUTE COMES FROM src/lib/fssai.ts, NOT FROM HERE.
 *
 * ⚠️ THIS WAS A REAL DEFECT, FOUND AND FIXED IN THIS LANE. The vocabulary module
 * was committed (f1223a0) precisely so "the limit that shrinks a photograph and
 * the limit that refuses one can never disagree" — and then this route kept its
 * own private numbers, which disagreed with it on every single one: 6 photographs
 * per answer here against 4 there, 30 per run against 24, its own data-URI regex
 * against parseFssaiDataUri, and a character cap (400,000 chars ≈ 293 KB decoded)
 * against a byte cap (400 KB decoded ≈ 546,000 chars). So the server would have
 * refused a photograph 300 KB in size while the shared vocabulary told the phone
 * 400 KB was allowed, and the person in the cold room would have had no way to
 * find out which was true. The numbers now have exactly one home — the import at
 * the top of this file — and `parseFssaiDataUri` does the validation, so the
 * stored-XSS guard (only base64 image/jpeg|png|webp, charset checked) is also
 * shared rather than re-written here.
 */

function metaOf(row: any) {
  return {
    id: row.id,
    run_id: row.run_id,
    response_id: row.response_id,
    question_id: row.question_id ?? null,
    kind: row.kind,
    filename: row.filename,
    mime: row.mime,
    size_bytes: Number(row.size_bytes) || 0,
    caption: row.caption,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;
  try {
    const url = new URL(request.url);
    const db = getDb();

    /* ── one attachment, with the image ─────────────────────────────────────── */
    const id = str(url.searchParams.get('id'));
    if (id) {
      const row = db.prepare(
        `SELECT e.*, r.question_id AS question_id
           FROM fssai_evidence e LEFT JOIN fssai_responses r ON r.id = e.response_id
          WHERE e.id = ?`,
      ).get(id) as any;
      if (!row) return Response.json({ error: 'That photograph is no longer there.' }, { status: 404 });
      const run = db.prepare(`SELECT id, recorded_by, department_id FROM fssai_runs WHERE id = ?`).get(row.run_id) as any;
      if (!run || !canSeeFssaiRun(me, run)) {
        return Response.json({ error: 'That check belongs to another department.' }, { status: 403 });
      }
      return Response.json({ evidence: { ...metaOf(row), data_uri: row.data_uri } });
    }

    /* ── every attachment on one run, WITHOUT the images ────────────────────── */
    const runId = str(url.searchParams.get('run_id'));
    if (!runId) return Response.json({ error: 'Which check? No id was sent.' }, { status: 400 });
    const run = db.prepare(`SELECT id, recorded_by, department_id FROM fssai_runs WHERE id = ?`).get(runId) as any;
    if (!run) return Response.json({ error: 'That check no longer exists.' }, { status: 404 });
    if (!canSeeFssaiRun(me, run)) {
      return Response.json({ error: 'That check belongs to another department.' }, { status: 403 });
    }
    const rows = db.prepare(
      `SELECT e.id, e.run_id, e.response_id, e.kind, e.filename, e.mime, e.size_bytes, e.caption,
              e.created_by, e.created_at, r.question_id AS question_id
         FROM fssai_evidence e LEFT JOIN fssai_responses r ON r.id = e.response_id
        WHERE e.run_id = ? ORDER BY e.created_at ASC`,
    ).all(runId) as any[];
    return Response.json({
      run_id: runId,
      evidence: rows.map(metaOf),
      // So the runner can show "2 of 6" without a second call, and so a client
      // that has drifted from these numbers is corrected by the server.
      limits: {
        max_per_answer: FSSAI_EVIDENCE_MAX_PER_ANSWER,
        max_per_run: FSSAI_EVIDENCE_MAX_PER_RUN,
        max_bytes: FSSAI_PHOTO_MAX_BYTES,
        target_bytes: FSSAI_PHOTO_TARGET_BYTES,
        max_bytes_label: fssaiBytesLabel(FSSAI_PHOTO_MAX_BYTES),
        mimes: FSSAI_PHOTO_MIMES,
      },
    });
  } catch (e: any) {
    console.error('GET /api/fssai/evidence failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the photographs' }, { status: 500 });
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
    if (run.status !== 'in_progress') {
      // Owner §19: a finished record is not edited. Adding a photograph after the
      // fact would change what was signed.
      return Response.json(
        { error: 'That check has already been submitted, so nothing more can be attached to it.' },
        { status: 409 },
      );
    }
    if (String(run.recorded_by || '').toLowerCase() !== String(me.email || '').toLowerCase()) {
      return Response.json(
        { error: `This check is open in ${run.recorded_name || run.recorded_by}'s name. A manager can hand it over to you.` },
        { status: 403 },
      );
    }

    /* ── which answer is this photograph for? ───────────────────────────────── */
    const responseId = str(body?.response_id);
    const questionId = str(body?.question_id);
    let response: any = null;
    if (responseId) {
      response = db.prepare(`SELECT * FROM fssai_responses WHERE id = ? AND run_id = ?`).get(responseId, runId);
      if (!response) return Response.json({ error: 'That answer is not part of this check.' }, { status: 400 });
    } else if (questionId) {
      response = db.prepare(`SELECT * FROM fssai_responses WHERE run_id = ? AND question_id = ?`).get(runId, questionId);
      if (!response) {
        // RULE 1. Not an error the person needs to read — a step the runner takes
        // for them: write the answer row, then attach. The code is what makes that
        // automatic instead of a dead end.
        return Response.json(
          {
            error: 'The answer has to be written down before a photograph can be attached to it.',
            code: 'answer_first', question_id: questionId,
          },
          { status: 409 },
        );
      }
    } else {
      return Response.json({ error: 'Which question is this photograph for? No id was sent.' }, { status: 400 });
    }

    /* ── the image itself ───────────────────────────────────────────────────── */
    const kind = str(body?.kind) || 'photo';
    if (kind !== 'photo') {
      return Response.json(
        { error: `Only photographs can be attached to a check today (this asked for "${kind}"). Certificates and documents come with the documents register.` },
        { status: 400 },
      );
    }
    const dataUri = String(body?.data_uri ?? '').trim();
    if (!dataUri) return Response.json({ error: 'No photograph arrived. Try taking it again.' }, { status: 400 });

    /* ONE validator, shared with the phone (parseFssaiDataUri). It refuses
     * anything that is not a base64 JPG/PNG/WebP — the stored string is handed
     * back to a browser as an <img src>, so `data:text/html;base64,…` in this
     * column would be a stored XSS on a food-safety record — and it refuses one
     * over FSSAI_PHOTO_MAX_BYTES in words, well inside nginx's real 1 MB
     * (HARD RULE 14), because a bare 413 from nginx never reaches this code and
     * no error handler in this app turns it into a sentence. */
    const parsed = parseFssaiDataUri(dataUri);
    if (!parsed.ok) {
      return Response.json(
        { error: parsed.error, code: parsed.code },
        { status: parsed.code === 'too_big' ? 413 : 400 },
      );
    }
    const mime = parsed.mime;
    const sizeBytes = parsed.bytes;

    /* ── the caps ───────────────────────────────────────────────────────────── */
    const perAnswer = (db.prepare(
      `SELECT COUNT(*) AS n FROM fssai_evidence WHERE response_id = ?`,
    ).get(response.id) as any).n as number;
    if (perAnswer >= FSSAI_EVIDENCE_MAX_PER_ANSWER) {
      return Response.json(
        { error: `This answer already has ${perAnswer} photographs, which is as many as one answer can hold. Remove one first.` },
        { status: 409 },
      );
    }
    const perRun = (db.prepare(`SELECT COUNT(*) AS n FROM fssai_evidence WHERE run_id = ?`).get(runId) as any).n as number;
    if (perRun >= FSSAI_EVIDENCE_MAX_PER_RUN) {
      return Response.json(
        { error: `This check already has ${perRun} photographs on it, which is the most one check can hold.` },
        { status: 409 },
      );
    }

    /* ── the live question, for re-judging the answer ────────────────────────── */
    const q = db.prepare(`SELECT * FROM fssai_questions WHERE id = ?`).get(response.question_id) as any;
    const evidenceId = generateId();
    const filename = str(body?.filename).slice(0, 120) || `check-${new Date().toISOString().slice(0, 10)}.${mime.replace('image/', '')}`;
    const caption = str(body?.caption).slice(0, 400);

    const attach = db.transaction(() => {
      db.prepare(
        `INSERT INTO fssai_evidence
           (id, run_id, response_id, kind, data_uri, filename, mime, size_bytes, caption, created_by, outlet_id)
         VALUES (?, ?, ?, 'photo', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(evidenceId, runId, response.id, dataUri, filename, mime, sizeBytes, caption, me.email || '', outletId);

      // RULE 3 — re-judge THIS answer with the photograph counted. Without this a
      // photo question keeps the "No photograph attached" failure it was frozen
      // with, and a question marked "Photo: Always" keeps a stale verdict.
      let verdict: ReturnType<typeof evaluateFssaiAnswer> | null = null;
      if (q) {
        const count = (db.prepare(
          `SELECT COUNT(*) AS n FROM fssai_evidence WHERE response_id = ?`,
        ).get(response.id) as any).n as number;
        verdict = evaluateFssaiAnswer(
          {
            qtype: String(response.qtype || q.qtype || ''),
            is_required: q.is_required, allow_na: q.allow_na,
            min_value: q.min_value, max_value: q.max_value, expected_value: q.expected_value,
            options: parseJsonArray(q.options_json),
            fail_options: parseJsonArray(q.fail_options_json),
            photo_rule: q.photo_rule, note_rule: q.note_rule,
          },
          {
            value_text: response.value_text,
            value_num: response.value_num,
            value_bool: response.value_bool === null || response.value_bool === undefined ? null : !!Number(response.value_bool),
            is_na: !!Number(response.is_na),
            note: response.note,
            evidence_count: count,
          },
        );
        db.prepare(
          `UPDATE fssai_responses SET is_fail = ?, updated_at = datetime('now') WHERE id = ?`,
        ).run(verdict.is_fail ? 1 : 0, response.id);
      }
      const answered = recomputeFssaiAnsweredCount(db, runId, run.template_id);
      // §7 Q4: never lose a check a member of staff really performed because a
      // log row failed — the photograph is part of that check.
      fssaiAuditBestEffort(db, {
        entity_table: 'fssai_evidence', entity_id: evidenceId, action: 'create',
        after: {
          run_id: runId, response_id: response.id, question_id: response.question_id,
          mime, size_bytes: sizeBytes, filename,
        },
        actor: { email: me.email, name: me.name }, outlet_id: outletId,
      });
      return { verdict, answered };
    });
    const { verdict, answered } = attach();

    const row = db.prepare(
      `SELECT e.id, e.run_id, e.response_id, e.kind, e.filename, e.mime, e.size_bytes, e.caption,
              e.created_by, e.created_at, r.question_id AS question_id
         FROM fssai_evidence e LEFT JOIN fssai_responses r ON r.id = e.response_id
        WHERE e.id = ?`,
    ).get(evidenceId) as any;
    const fresh = db.prepare(`SELECT * FROM fssai_responses WHERE id = ?`).get(response.id) as any;
    const evCount = fssaiEvidenceCountsByQuestion(db, runId).get(String(response.question_id)) || 0;

    return Response.json({
      evidence: metaOf(row),
      response: fresh,
      verdict,
      // The same completeness the submit gate will apply, so the card can say
      // "still needs a note" the moment the photograph lands.
      complete: fssaiAnswerComplete(q, fresh, evCount),
      answered_count: answered,
      evidence_count: evCount,
      qtype_known: !!qtypeMeta(String(fresh?.qtype || q?.qtype || '')),
    });
  } catch (e: any) {
    console.error('POST /api/fssai/evidence failed:', e);
    return Response.json({ error: e?.message || 'Failed to save the photograph' }, { status: 500 });
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
    const id = str(url.searchParams.get('id'));
    if (!id) return Response.json({ error: 'Which photograph? No id was sent.' }, { status: 400 });

    const row = db.prepare(`SELECT * FROM fssai_evidence WHERE id = ?`).get(id) as any;
    if (!row) return Response.json({ error: 'That photograph is no longer there.' }, { status: 404 });
    const run = db.prepare(`SELECT * FROM fssai_runs WHERE id = ?`).get(row.run_id) as any;
    if (!run) return Response.json({ error: 'That check no longer exists.' }, { status: 404 });
    if (run.status !== 'in_progress') {
      // Owner §19: a recorded check is voided with a reason, never edited. A
      // photograph on it is evidence, not a draft.
      return Response.json(
        { error: 'This check has been submitted, so its photographs are part of the record. A manager can void the whole record if it was a mistake.' },
        { status: 409 },
      );
    }
    if (String(run.recorded_by || '').toLowerCase() !== String(me.email || '').toLowerCase()) {
      return Response.json(
        { error: `This check is open in ${run.recorded_name || run.recorded_by}'s name. A manager can hand it over to you.` },
        { status: 403 },
      );
    }

    const response = db.prepare(`SELECT * FROM fssai_responses WHERE id = ?`).get(row.response_id) as any;
    const q = response ? db.prepare(`SELECT * FROM fssai_questions WHERE id = ?`).get(response.question_id) as any : null;
    const reason = str(url.searchParams.get('reason')) || 'Removed while the check was still open';

    const drop = db.transaction(() => {
      db.prepare(`DELETE FROM fssai_evidence WHERE id = ?`).run(id);
      // Re-judge: taking the photograph away can put the answer back to
      // incomplete, and the progress bar and the submit gate must both know.
      if (q && response) {
        const count = (db.prepare(
          `SELECT COUNT(*) AS n FROM fssai_evidence WHERE response_id = ?`,
        ).get(response.id) as any).n as number;
        const verdict = evaluateFssaiAnswer(
          {
            qtype: String(response.qtype || q.qtype || ''),
            is_required: q.is_required, allow_na: q.allow_na,
            min_value: q.min_value, max_value: q.max_value, expected_value: q.expected_value,
            options: parseJsonArray(q.options_json),
            fail_options: parseJsonArray(q.fail_options_json),
            photo_rule: q.photo_rule, note_rule: q.note_rule,
          },
          {
            value_text: response.value_text, value_num: response.value_num,
            value_bool: response.value_bool === null || response.value_bool === undefined ? null : !!Number(response.value_bool),
            is_na: !!Number(response.is_na), note: response.note, evidence_count: count,
          },
        );
        db.prepare(`UPDATE fssai_responses SET is_fail = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(verdict.is_fail ? 1 : 0, response.id);
      }
      recomputeFssaiAnsweredCount(db, row.run_id, run.template_id);
      // A removal is the one thing on this route that must be recorded even at
      // the cost of the operation: it is the only way an attachment leaves a
      // check, so fssaiAudit (which throws) is deliberate.
      fssaiAudit(db, {
        entity_table: 'fssai_evidence', entity_id: id, action: 'delete',
        before: {
          run_id: row.run_id, response_id: row.response_id, filename: row.filename,
          mime: row.mime, size_bytes: row.size_bytes,
        },
        reason,
        actor: { email: me.email, name: me.name }, outlet_id: run.outlet_id,
      });
    });
    drop();
    fssaiAppAudit(db, {
      event_type: 'fssai.evidence.delete', entity_type: 'fssai_evidence', entity_id: id,
      actor_email: me.email, before: { run_id: row.run_id, filename: row.filename }, note: reason,
    });

    const fresh = response ? db.prepare(`SELECT * FROM fssai_responses WHERE id = ?`).get(response.id) as any : null;
    const evCount = response
      ? fssaiEvidenceCountsByQuestion(db, row.run_id).get(String(response.question_id)) || 0
      : 0;
    const answered = (db.prepare(`SELECT answered_count FROM fssai_runs WHERE id = ?`).get(row.run_id) as any)?.answered_count ?? 0;
    return Response.json({
      ok: true, deleted: true, response: fresh,
      complete: fresh ? fssaiAnswerComplete(q, fresh, evCount) : null,
      evidence_count: evCount, answered_count: Number(answered) || 0,
    });
  } catch (e: any) {
    console.error('DELETE /api/fssai/evidence failed:', e);
    return Response.json({ error: e?.message || 'Failed to remove the photograph' }, { status: 500 });
  }
}
