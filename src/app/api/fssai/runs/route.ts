/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, isManagement } from '@/lib/auth';
import {
  canRunFssaiCheck, canTakeOverFssaiRun, decideFssaiSlot, evaluateFssaiAnswer,
  summariseFssaiRun, fssaiToday, isISODate, daysBetweenISO, isFssaiShift, isFssaiTargetKind,
  fssaiResponseAnswered, isFssaiBoolQType, fssaiBoolFromText, fssaiBoolWordsFor,
  fssaiDisplayReading, FSSAI_SIGNATURE_STATEMENT, fssaiSignatureStatement,
  FSSAI_REQUIRE_EXPLICIT_SIGNATURE,
  type FssaiSlotRunRow, type FssaiSignatureMode,
} from '@/lib/fssai';
import {
  requireFssaiUser, fssaiAudit, fssaiAuditBestEffort, fssaiAppAudit, parseJsonArray,
  shapeQuestion, str, constraintMessage, FSSAI_NO_MATCH,
  readFssaiRecordSnapshot, writeFssaiRecordSnapshot, fssaiSignatureState, signFssaiRun,
  raiseFssaiCorrectiveActions, readFssaiCorrectiveActions,
  type FssaiRecordSnapshotQuestion, type FssaiCaRaised,
} from '@/lib/fssai-server';

/**
 * RUNNING A CHECK — the ENGINE (/api/fssai/runs).
 *
 * SCOPE NOTE. P2 owns the checklist ENGINE; P3 owns the phone experience. This
 * file is the server half of a run — opening one, answering a question,
 * submitting, taking one over and voiding it — because two P2 rules cannot be
 * enforced anywhere else:
 *   1. §7 Q12, the one-run-per-slot rule (the schema cannot express it), and
 *   2. the version freeze, which is the single most important correctness
 *      property in this phase.
 * The screens, the photo evidence, the signature UX and the verification queue
 * are P3's and P7's. P3 may extend these handlers; it should not reinvent them.
 *
 * GET  ?id=<run>            → one run. A run that is NOT in_progress renders
 *                             from fssai_responses ALONE — see below.
 *      ?slot=1&template_id=&business_date=&target_id=&shift=
 *                           → "can I start this?", answered by the SAME
 *                             predicate the POST uses, so the button and the
 *                             refusal can never disagree.
 *      (otherwise)          → a list, scoped to what the caller may see.
 * POST { action: 'open' | 'answer' | 'submit' | 'takeover' | 'void' }
 *
 * ── THE RULE THAT MAKES HISTORY SAFE ─────────────────────────────────────
 * A run whose status is not 'in_progress' is rendered, exported and reported
 * ONLY from fssai_responses plus the frozen counters on fssai_runs. This read
 * path NEVER joins fssai_questions for such a run and NEVER recomputes is_fail
 * or pass_pct. That is what makes a checklist completed last Tuesday still
 * show last Tuesday's questions, thresholds and answers after the owner edits
 * the template today. The schema provides the columns (prompt_snapshot, qtype,
 * uom, min_used, max_used, expected_used, is_fail); only code can keep the
 * promise — so it is kept HERE, in one place (RECON §10 R3).
 */
export const dynamic = 'force-dynamic';

/**
 * IS THERE AN ANSWER IN THIS BOX? — delegated to the shared predicate.
 *
 * It used to be a local rule here ("any non-empty value_text"), which
 * DISAGREED with the evaluator: a Yes/No answer sent as the word 'yes' counted
 * as answered here and as unanswered there, so the submit gate let through a
 * question the evaluator considered blank. One predicate now, in src/lib/fssai.ts.
 */
function isAnswered(r: any, evidenceCount = 0): boolean {
  return fssaiResponseAnswered(r, evidenceCount);
}

/**
 * IS THIS ANSWER FINISHED? — a value present AND any photograph or note the
 * question demands. The evidence rules (photo_rule / note_rule) are the admin's
 * "required evidence" setting; they were stored and never read until this.
 * Only `.answered` is taken from the evaluator — is_fail stays frozen on the
 * response row and is never recomputed on read (RECON §10 R3).
 */
function answerComplete(q: any, r: any, evidenceCount = 0): { answered: boolean; reason: string } {
  if (!r) return { answered: false, reason: 'Not answered.' };
  const v = evaluateFssaiAnswer(
    {
      // The FROZEN type: the answer is judged complete as the type it was given
      // under, even if the live question has been changed since.
      qtype: String(r.qtype || q?.qtype || ''),
      is_required: q ? q.is_required : 1,
      allow_na: q ? q.allow_na : 1,
      photo_rule: q?.photo_rule,
      note_rule: q?.note_rule,
    },
    {
      value_text: r.value_text,
      value_num: r.value_num,
      value_bool: r.value_bool === null || r.value_bool === undefined ? null : !!Number(r.value_bool),
      is_na: !!Number(r.is_na),
      note: r.note,
      evidence_count: evidenceCount,
    },
  );
  return { answered: v.answered, reason: v.reason };
}

/** How many evidence rows hang off each answer in this run, by question id. */
function evidenceCountsByQuestion(db: any, runId: string): Map<string, number> {
  const rows = db.prepare(
    `SELECT r.question_id AS qid, COUNT(e.id) AS n
       FROM fssai_responses r LEFT JOIN fssai_evidence e ON e.response_id = r.id
      WHERE r.run_id = ? GROUP BY r.question_id`,
  ).all(runId) as any[];
  return new Map(rows.map((r) => [String(r.qid), Number(r.n) || 0]));
}

/**
 * May this person read this run? (§7 Q10 provisional: own + own department;
 * management sees all.)
 *
 * A run with NO department belongs to the whole restaurant, so any signed-in
 * member of staff may read it. Measured defect: a restaurant-wide check
 * (target_kind='none', no department) refused the second person with "That check
 * belongs to another department" — about a record that belongs to no department
 * at all, and which he was being blocked by. Blocking someone with a record he
 * is forbidden to look at leaves him nothing he can do.
 */
function canSeeRun(me: any, run: any): boolean {
  if (isManagement(me)) return true;
  if (String(run.recorded_by || '').toLowerCase() === String(me.email || '').toLowerCase()) return true;
  if (!String(run.department_id || '')) return true;
  return !!run.department_id && run.department_id === me.department_id;
}

/** Whether the caller may actually OPEN the run that is blocking them. */
function slotViewability(
  me: any,
  decision: { action: string; run_id?: string },
  openRun: FssaiSlotRunRow | null,
  decidedRun: FssaiSlotRunRow | null,
): { can_view?: boolean } {
  if (decision.action !== 'refuse') return {};
  const row = openRun && openRun.id === decision.run_id ? openRun
    : decidedRun && decidedRun.id === decision.run_id ? decidedRun
    : null;
  if (!row) return {};
  return { can_view: canSeeRun(me, row) };
}

/** The two rows the slot decision needs, read with ONE predicate everywhere. */
function readSlot(db: any, slot: { template_id: string; business_date: string; target_id: string; shift: string }) {
  const openRun = db.prepare(
    `SELECT id, status, recorded_by, recorded_name, started_at, answered_count, total_count,
            outcome, department_id
       FROM fssai_runs
      WHERE template_id=? AND business_date=? AND IFNULL(target_id,'')=? AND IFNULL(shift,'')=?
        AND status='in_progress'
      LIMIT 1`,
  ).get(slot.template_id, slot.business_date, slot.target_id, slot.shift) as FssaiSlotRunRow | undefined;

  const decidedRun = db.prepare(
    `SELECT id, status, recorded_by, recorded_name, submitted_at, answered_count, total_count,
            outcome, department_id
       FROM fssai_runs
      WHERE template_id=? AND business_date=? AND IFNULL(target_id,'')=? AND IFNULL(shift,'')=?
        AND status IN ('submitted','verified')
      ORDER BY submitted_at DESC LIMIT 1`,
  ).get(slot.template_id, slot.business_date, slot.target_id, slot.shift) as FssaiSlotRunRow | undefined;

  // 'rejected' and 'void' deliberately do NOT close a slot: a check sent back
  // must be redoable, and a voided one never happened.
  return { openRun: openRun || null, decidedRun: decidedRun || null };
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  try {
    const url = new URL(request.url);
    const db = getDb();

    /* ── "can I start this?" — the shared predicate ───────────────────────── */
    if (url.searchParams.get('slot') === '1') {
      const slot = {
        template_id: str(url.searchParams.get('template_id')),
        business_date: str(url.searchParams.get('business_date')) || fssaiToday(),
        target_id: str(url.searchParams.get('target_id')),
        shift: str(url.searchParams.get('shift')),
      };
      if (!slot.template_id) return Response.json({ error: 'Which checklist? No id was sent.' }, { status: 400 });
      const { openRun, decidedRun } = readSlot(db, slot);
      const decision = decideFssaiSlot({ meEmail: me.email || '', openRun, decidedRun });
      // can_view tells a screen whether to offer "look at what has been filled
      // in" at all: offering a button that then 403s is worse than not offering
      // it (measured — a cross-department block did exactly that).
      return Response.json({ slot, decision, ...slotViewability(me, decision, openRun, decidedRun) });
    }

    /* ── one run ──────────────────────────────────────────────────────────── */
    const id = str(url.searchParams.get('id'));
    if (id) {
      const run = db.prepare(`SELECT * FROM fssai_runs WHERE id = ?`).get(id) as any;
      if (!run) return Response.json({ error: 'That check no longer exists.' }, { status: 404 });
      if (!canSeeRun(me, run)) {
        return Response.json({ error: 'That check belongs to another department.' }, { status: 403 });
      }
      const tpl = db.prepare(
        `SELECT id, name, code, version, pass_threshold_pct, requires_signature, requires_verification,
                department_id, module_key, frequency
           FROM fssai_templates WHERE id = ?`,
      ).get(run.template_id) as any;

      const responses = db.prepare(
        `SELECT * FROM fssai_responses WHERE run_id = ? ORDER BY sort_order ASC, answered_at ASC`,
      ).all(id) as any[];

      if (run.status !== 'in_progress') {
        // FROZEN. No join to fssai_questions, no recomputation of anything.
        //
        // The TITLE is frozen too, from the snapshot written at submit. It used
        // to be read live, so renaming a checklist today re-labelled every
        // record ever taken under it — and because a rename does not bump the
        // version, `edited_since` stayed false and nothing said so. The record
        // now shows the name it was taken under; `template_now` carries what it
        // is called today, for a screen that wants to say "now called …".
        const snap = readFssaiRecordSnapshot(db, id);
        const asRecorded = snap?.template;
        return Response.json({
          run,
          template: asRecorded
            ? {
                id: asRecorded.id,
                name: asRecorded.name,
                code: asRecorded.code,
                current_version: tpl ? tpl.version : null,
                pass_threshold_pct: asRecorded.pass_threshold_pct,
              }
            : tpl
              ? { id: tpl.id, name: tpl.name, code: tpl.code, current_version: tpl.version }
              : null,
          template_name_source: asRecorded ? 'snapshot' : 'live',
          template_now: tpl ? { id: tpl.id, name: tpl.name, code: tpl.code, version: tpl.version } : null,
          template_renamed_since: !!asRecorded && !!tpl
            && (String(asRecorded.name) !== String(tpl.name) || String(asRecorded.code || '') !== String(tpl.code || '')),
          responses,
          questions: null,
          // THE SHEET AS IT WAS ASKED — every question that was on it, including
          // the ones left blank and the ones retired while it was open, so the
          // record can say what was skipped even after the question is gone.
          sheet_as_asked: snap ? snap.sheet : null,
          rendered_from: 'responses',
          template_version_at_record: run.template_version,
          // A round filled in across several versions is stamped with the LAST
          // one on fssai_runs; these two say what it was opened on and submitted
          // under, so the record never claims a single paper it was not wholly
          // answered against.
          template_version_at_open: asRecorded ? asRecorded.version_at_open : null,
          template_version_at_submit: asRecorded ? asRecorded.version_at_submit : null,
          answered_across_versions: asRecorded ? !!asRecorded.answered_across_versions : null,
          template_version_now: tpl ? tpl.version : null,
          edited_since: !!tpl && Number(tpl.version) !== Number(run.template_version),
          /* WHAT WAS RAISED AGAINST THIS RECORD (owner Q14). Carried on the
           * record itself so somebody opening a failed check sees the follow-up
           * and its state there, rather than having to know that a separate
           * queue exists. */
          corrective_actions: readFssaiCorrectiveActions(db, id),
        });
      }

      // Still open: the live questions are what the runner must show, and the
      // template may have been edited since it was started. Say so plainly
      // rather than swapping the paper underneath whoever is holding it.
      const questions = (db.prepare(
        `SELECT * FROM fssai_questions WHERE template_id = ? AND is_active = 1 ORDER BY sort_order ASC, created_at ASC`,
      ).all(run.template_id) as any[]).map(shapeQuestion);
      const sections = db.prepare(
        `SELECT * FROM fssai_sections WHERE template_id = ? AND is_active = 1 ORDER BY sort_order ASC, created_at ASC`,
      ).all(run.template_id) as any[];

      return Response.json({
        run, template: tpl, responses, questions, sections,
        rendered_from: 'template',
        template_version_at_start: run.template_version,
        template_version_now: tpl ? tpl.version : null,
        edited_since_started: !!tpl && Number(tpl.version) !== Number(run.template_version),
      });
    }

    /* ── a list ───────────────────────────────────────────────────────────── */
    const where: string[] = [];
    const args: any[] = [];
    const templateId = str(url.searchParams.get('template_id'));
    const businessDate = str(url.searchParams.get('business_date'));
    const status = str(url.searchParams.get('status'));
    const mine = url.searchParams.get('mine') === '1';
    if (templateId) { where.push('r.template_id = ?'); args.push(templateId); }
    if (businessDate) { where.push('r.business_date = ?'); args.push(businessDate); }
    if (status) { where.push('r.status = ?'); args.push(status); }
    if (mine || !isManagement(me)) {
      // FSSAI_NO_MATCH, never '': a user with no email or no department must
      // see NOTHING, not every row whose column happens to be blank.
      if (mine) { where.push('lower(r.recorded_by) = lower(?)'); args.push(me.email || FSSAI_NO_MATCH); }
      else {
        where.push(`(lower(r.recorded_by) = lower(?) OR (r.department_id <> '' AND r.department_id = ?))`);
        args.push(me.email || FSSAI_NO_MATCH, me.department_id || FSSAI_NO_MATCH);
      }
    }
    // template_name is what the checklist is called TODAY;
    // template_name_at_record is what it was called when the check was taken
    // (from the frozen snapshot, NULL for a run still open or taken before the
    // snapshot existed). A history screen must lead with the second one.
    const runs = db.prepare(
      `SELECT r.*, t.name AS template_name,
              (SELECT json_extract(a.after_json, '$.template.name')
                 FROM fssai_audit_log a
                WHERE a.entity_table='fssai_runs' AND a.entity_id=r.id AND a.action='snapshot'
                ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1) AS template_name_at_record
         FROM fssai_runs r JOIN fssai_templates t ON t.id = r.template_id` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY r.business_date DESC, r.started_at DESC LIMIT 500`,
    ).all(...args) as any[];
    return Response.json({ runs });
  } catch (e: any) {
    console.error('GET /api/fssai/runs failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the checks' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;
  if (!canRunFssaiCheck(me)) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let body: any = {};
  try { body = await request.json(); } catch { /* validated below */ }
  const action = str(body?.action) || 'open';

  try {
    const db = getDb();
    const outletId = (await getCurrentOutletId()) || '';

    /* ══════════════════════════════════════════════════════════════════════
     * OPEN — §7 Q12 lives here.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'open') {
      const templateId = str(body?.template_id);
      if (!templateId) return Response.json({ error: 'Which checklist? No id was sent.' }, { status: 400 });
      const tpl = db.prepare(`SELECT * FROM fssai_templates WHERE id = ?`).get(templateId) as any;
      if (!tpl) return Response.json({ error: 'That checklist no longer exists.' }, { status: 404 });
      if (tpl.status !== 'published' || !Number(tpl.is_active)) {
        // An archived checklist and a draft are refused for different reasons,
        // and telling a chef "not published yet" about a sheet he ran last week
        // is a lie he cannot act on.
        const why = tpl.status === 'archived'
          ? `"${tpl.name}" has been archived, so no new checks can be started against it. The records already taken are still there.`
          : `"${tpl.name}" has not been published yet, so it cannot be run. Ask an administrator to publish it.`;
        return Response.json({ error: why }, { status: 409 });
      }

      const today = fssaiToday();
      const businessDate = str(body?.business_date) || today;
      if (!isISODate(businessDate)) return Response.json({ error: 'That is not a real date.' }, { status: 400 });
      const age = daysBetweenISO(businessDate, today);   // today − businessDate
      if (age < 0) return Response.json({ error: 'A check cannot be recorded for a date in the future.' }, { status: 400 });

      // §7 Q9 (PROVISIONAL DEFAULT): backdating is allowed within the
      // template's allow_backdate_days, ALWAYS with a reason, and the row is
      // flagged. Set allow_backdate_days to 0 to forbid it — no code change.
      const backdateReason = str(body?.backdate_reason);
      if (age > 0) {
        const allowed = Number(tpl.allow_backdate_days ?? 0);
        if (allowed <= 0) {
          return Response.json({ error: 'This check must be recorded on the day it is done.' }, { status: 400 });
        }
        if (age > allowed) {
          return Response.json(
            { error: `This check can only be backdated ${allowed} day${allowed === 1 ? '' : 's'}. ${businessDate} is ${age} days ago.` },
            { status: 400 },
          );
        }
        if (!backdateReason) {
          return Response.json({ error: 'Say why this check is being recorded late.' }, { status: 400 });
        }
      }

      const shift = str(body?.shift);
      if (!isFssaiShift(shift)) return Response.json({ error: `"${shift}" is not one of the shifts.` }, { status: 400 });
      const targetKind = str(body?.target_kind) || tpl.target_kind || 'none';
      if (!isFssaiTargetKind(targetKind)) return Response.json({ error: `"${targetKind}" is not something a check can be run against.` }, { status: 400 });
      const targetId = str(body?.target_id);
      if (targetKind !== 'none' && !targetId) {
        return Response.json({ error: 'Choose what this check is being run against.' }, { status: 400 });
      }

      const slot = { template_id: templateId, business_date: businessDate, target_id: targetId, shift };
      const { openRun, decidedRun } = readSlot(db, slot);
      const decision = decideFssaiSlot({ meEmail: me.email || '', openRun, decidedRun });

      if (decision.action === 'resume') {
        // RESUME, NEVER DUPLICATE — the HRMS attempt rule
        // (api/hr/tests/route.ts:383-392). The half-finished round keeps its
        // own id, its answers and its started_at.
        const run = db.prepare(`SELECT * FROM fssai_runs WHERE id = ?`).get(decision.run_id);
        return Response.json({ run, resumed: true, decision });
      }
      if (decision.action === 'refuse') {
        return Response.json(
          {
            error: decision.message, code: decision.code, run_id: decision.run_id, decision,
            ...slotViewability(me, decision, openRun, decidedRun),
          },
          { status: 409 },
        );
      }

      const questionCount = (db.prepare(
        `SELECT COUNT(*) AS n FROM fssai_questions WHERE template_id = ? AND is_active = 1`,
      ).get(templateId) as any).n as number;
      if (questionCount === 0) {
        return Response.json({ error: 'That checklist has no questions yet.' }, { status: 409 });
      }

      const id = generateId();
      const create = db.transaction(() => {
        db.prepare(
          `INSERT INTO fssai_runs
             (id, template_id, template_version, assignment_id, business_date, shift, target_kind,
              target_id, target_label, department_id, equipment_id, grn_id, batch_id, status,
              recorded_by, recorded_name, total_count, is_backdated, backdate_reason, outlet_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, ?)`,
        ).run(
          id, templateId,
          // FROZEN AT CREATE, inside this transaction (risk R3). A template
          // edited tomorrow cannot rewrite what this run was taken against.
          tpl.version,
          str(body?.assignment_id) || null,
          businessDate, shift, targetKind, targetId, str(body?.target_label),
          str(body?.department_id) || tpl.department_id || '',
          str(body?.equipment_id), str(body?.grn_id), str(body?.batch_id),
          me.email || '', me.name || '', questionCount,
          age > 0 ? 1 : 0, age > 0 ? backdateReason : '', outletId,
        );
        fssaiAuditBestEffort(db, {
          entity_table: 'fssai_runs', entity_id: id, action: 'create',
          after: { template_id: templateId, template_version: tpl.version, business_date: businessDate, shift, target_id: targetId },
          reason: age > 0 ? `Backdated ${age} day${age === 1 ? '' : 's'}: ${backdateReason}` : '',
          actor: { email: me.email, name: me.name }, outlet_id: outletId,
        });
      });
      create();
      return Response.json({ run: db.prepare(`SELECT * FROM fssai_runs WHERE id = ?`).get(id), created: true });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * ANSWER — freezes the question and the rule it was judged by.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'answer') {
      const runId = str(body?.run_id);
      const questionId = str(body?.question_id);
      if (!runId || !questionId) return Response.json({ error: 'Which check and which question? No ids were sent.' }, { status: 400 });

      const run = db.prepare(`SELECT * FROM fssai_runs WHERE id = ?`).get(runId) as any;
      if (!run) return Response.json({ error: 'That check no longer exists.' }, { status: 404 });
      if (run.status !== 'in_progress') {
        return Response.json({ error: 'That check has already been submitted and cannot be changed.' }, { status: 409 });
      }
      if (String(run.recorded_by || '').toLowerCase() !== String(me.email || '').toLowerCase()) {
        return Response.json(
          { error: `This check is open in ${run.recorded_name || run.recorded_by}'s name. A manager can hand it over to you.` },
          { status: 403 },
        );
      }

      const q = db.prepare(`SELECT * FROM fssai_questions WHERE id = ?`).get(questionId) as any;
      if (!q) return Response.json({ error: 'That question no longer exists.' }, { status: 404 });
      if (q.template_id !== run.template_id) {
        return Response.json({ error: 'That question belongs to a different checklist.' }, { status: 400 });
      }
      if (!Number(q.is_active)) {
        // A question switched off mid-round takes no NEW answer — it is off the
        // sheet. But an answer ALREADY GIVEN on this round still counts towards
        // the verdict (see submit), so the person holding the phone must be able
        // to CORRECT it. Refusing both left a recorded failure they could
        // neither change nor remove.
        const already = db.prepare(
          `SELECT id FROM fssai_responses WHERE run_id = ? AND question_id = ?`,
        ).get(runId, questionId) as any;
        if (!already) {
          return Response.json({ error: 'That question has been switched off since this check was started.' }, { status: 409 });
        }
      }

      // A blank reading is NOT zero (RECON §6.4 — Number('') === 0 stored 793
      // phantom counts in the closing-stock module).
      const rawNum = body?.value_num;
      const valueNum = rawNum === undefined || rawNum === null || String(rawNum).trim() === ''
        ? null
        : Number(rawNum);
      if (valueNum !== null && !Number.isFinite(valueNum)) {
        return Response.json({ error: 'That reading is not a number.' }, { status: 400 });
      }
      const rawBool = body?.value_bool;
      let valueBool = rawBool === undefined || rawBool === null || String(rawBool).trim() === ''
        ? null
        : (rawBool === true || rawBool === 1 || String(rawBool) === '1' || String(rawBool).toLowerCase() === 'true' ? 1 : 0);
      const valueText = str(body?.value_text);
      const isNa = body?.is_na === true || body?.is_na === 1 || String(body?.is_na) === '1';
      if (isNa && !Number(q.allow_na)) {
        return Response.json({ error: 'This question cannot be marked not-applicable.' }, { status: 400 });
      }

      // A TWO-BUTTON ANSWER MAY ARRIVE AS THE WORD. Measured defect: 'yes' sent
      // as value_text on a Yes/No question whose passing answer is 'yes' was
      // frozen as a compliance FAILURE, because only value_bool was read and an
      // absent boolean means "not answered". The word is now coerced into the
      // boolean with the SHARED word list, so the row is self-consistent
      // whichever way the client sends it — and a word nobody recognises is
      // refused by name rather than silently counted as a fail.
      if (!isNa && isFssaiBoolQType(q.qtype) && valueBool === null && valueText) {
        const coerced = fssaiBoolFromText(valueText);
        if (coerced === null) {
          return Response.json(
            { error: `"${valueText}" is not an answer to this question — answer ${fssaiBoolWordsFor(q.qtype)}.` },
            { status: 400 },
          );
        }
        valueBool = coerced ? 1 : 0;
      }

      if (q.qtype === 'multiple_choice' && valueText) {
        const opts = parseJsonArray(q.options_json);
        if (!opts.includes(valueText)) {
          return Response.json({ error: `"${valueText}" is not one of the answers on the list.` }, { status: 400 });
        }
      }

      const note = str(body?.note);
      const evidenceCount = (db.prepare(
        `SELECT COUNT(*) AS n FROM fssai_evidence WHERE run_id = ? AND response_id IN
           (SELECT id FROM fssai_responses WHERE run_id = ? AND question_id = ?)`,
      ).get(runId, runId, questionId) as any).n as number;

      const verdict = evaluateFssaiAnswer(
        {
          qtype: q.qtype, is_required: q.is_required, allow_na: q.allow_na,
          min_value: q.min_value, max_value: q.max_value, expected_value: q.expected_value,
          options: parseJsonArray(q.options_json),
          fail_options: parseJsonArray(q.fail_options_json),
          photo_rule: q.photo_rule, note_rule: q.note_rule,
        },
        {
          value_text: q.qtype === 'signature' ? (valueText || me.email || '') : valueText,
          value_num: valueNum, value_bool: valueBool === null ? null : !!valueBool,
          is_na: isNa, note, evidence_count: evidenceCount,
        },
      );

      const save = db.transaction(() => {
        // THE SNAPSHOT. prompt_snapshot / qtype / uom / min_used / max_used /
        // expected_used are what the question said AT THIS MOMENT, and is_fail
        // is the verdict frozen with them. Nothing downstream re-derives them.
        db.prepare(
          `INSERT INTO fssai_responses
             (id, run_id, question_id, qtype, prompt_snapshot, sort_order, value_text, value_num,
              value_bool, is_na, is_fail, min_used, max_used, expected_used, uom, note,
              answered_by, answered_at, outlet_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
           ON CONFLICT(run_id, question_id) DO UPDATE SET
             qtype=excluded.qtype, prompt_snapshot=excluded.prompt_snapshot,
             sort_order=excluded.sort_order, value_text=excluded.value_text,
             value_num=excluded.value_num, value_bool=excluded.value_bool, is_na=excluded.is_na,
             is_fail=excluded.is_fail, min_used=excluded.min_used, max_used=excluded.max_used,
             expected_used=excluded.expected_used, uom=excluded.uom, note=excluded.note,
             answered_by=excluded.answered_by, answered_at=datetime('now'),
             updated_at=datetime('now')`,
        ).run(
          generateId(), runId, questionId, q.qtype, q.prompt, q.sort_order,
          q.qtype === 'signature' ? (valueText || me.email || '') : valueText,
          valueNum, valueBool, isNa ? 1 : 0, verdict.is_fail ? 1 : 0,
          q.min_value, q.max_value, q.expected_value, q.uom, note,
          me.email || '', outletId,
        );
        // answered_count counts FINISHED answers — a value plus whatever
        // photograph or note the question demands — using the same predicate the
        // submit gate uses, so the number on screen and the gate agree.
        const rows = db.prepare(`SELECT * FROM fssai_responses WHERE run_id = ?`).all(runId) as any[];
        const ev = evidenceCountsByQuestion(db, runId);
        const liveQs = db.prepare(
          `SELECT id, qtype, is_required, allow_na, photo_rule, note_rule
             FROM fssai_questions WHERE template_id = ?`,
        ).all(run.template_id) as any[];
        const qById = new Map(liveQs.map((x) => [String(x.id), x]));
        const answered = rows.filter((r) =>
          answerComplete(qById.get(String(r.question_id)), r, ev.get(String(r.question_id)) || 0).answered,
        ).length;
        db.prepare(
          `UPDATE fssai_runs SET answered_count=?, updated_at=datetime('now') WHERE id=? AND status='in_progress'`,
        ).run(answered, runId);
        return answered;
      });
      const answered = save();
      const response = db.prepare(`SELECT * FROM fssai_responses WHERE run_id = ? AND question_id = ?`).get(runId, questionId) as any;
      return Response.json({
        response,
        verdict,
        answered_count: answered,
        // `decimals` is how the reading is WRITTEN DOWN, never how it is judged:
        // rounding before the range test would let 5.4 °C pass a 0–5 rule.
        display_value: fssaiDisplayReading(response?.value_num, q.decimals),
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * SUBMIT — freezes the counters, the verdict and the signature.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'submit') {
      const runId = str(body?.run_id);
      if (!runId) return Response.json({ error: 'Which check? No id was sent.' }, { status: 400 });
      const run = db.prepare(`SELECT * FROM fssai_runs WHERE id = ?`).get(runId) as any;
      if (!run) return Response.json({ error: 'That check no longer exists.' }, { status: 404 });
      if (run.status !== 'in_progress') {
        // The cheap read-first check; the real guard is the status-guarded
        // UPDATE below (HRMS api/hr/tests/route.ts:457 + :488).
        return Response.json({ error: 'That check has already been submitted.' }, { status: 409 });
      }
      if (String(run.recorded_by || '').toLowerCase() !== String(me.email || '').toLowerCase()) {
        return Response.json(
          { error: `This check is open in ${run.recorded_name || run.recorded_by}'s name, so only they can submit it.` },
          { status: 403 },
        );
      }

      const tpl = db.prepare(`SELECT * FROM fssai_templates WHERE id = ?`).get(run.template_id) as any;
      if (!tpl) return Response.json({ error: 'That checklist no longer exists.' }, { status: 404 });

      // §7 Q12, the other half: nothing may be submitted into a slot that
      // already holds a decided record.
      const { decidedRun } = readSlot(db, {
        template_id: run.template_id, business_date: run.business_date,
        target_id: run.target_id || '', shift: run.shift || '',
      });
      if (decidedRun && decidedRun.id !== runId) {
        return Response.json(
          {
            error: `This check has already been recorded for ${run.business_date}${run.shift ? ` (${run.shift})` : ''} by ${decidedRun.recorded_name || decidedRun.recorded_by}. Two records of one round would contradict each other — void one of them if this was a mistake.`,
            code: 'slot_already_recorded', run_id: decidedRun.id,
          },
          { status: 409 },
        );
      }

      /* ── WHAT THIS ROUND IS JUDGED ON ─────────────────────────────────────
       * THE QUESTIONS ON THE SHEET NOW, *PLUS* EVERY QUESTION THIS ROUND HAS
       * ALREADY ANSWERED — including one the admin switched off while it was
       * open.
       *
       * MEASURED DEFECT, the worst this phase found. The verdict was built from
       * `is_active = 1` alone, while the record printed every response row. So:
       * staff answer "Floor condition = Soiled" (a fail, frozen is_fail=1) → an
       * admin presses the ordinary delete on that question → the question is
       * lawfully RETIRED → staff submit → the failure is excluded from
       * fail_count, total_count, pass_pct, outcome AND from the is_critical
       * test. Measured: summary {fail_count:0, pass_pct:100, outcome:'pass'} on
       * a record that still prints `'Floor condition' = 'Soiled' IS_FAIL=1`.
       * One admin click turned a failed hygiene check into a passing one,
       * silently, with the failing line still on the sheet.
       *
       * Nothing anyone actually recorded may leave the verdict. A retired
       * question takes no NEW answer (the answer route still refuses that) —
       * but an answer already given is part of the record and is counted.
       */
      const liveQuestions = db.prepare(
        // raise_ca_on_fail / ca_severity are selected because the corrective
        // action is raised from THIS list (owner Q14) — the same list the verdict
        // is built from, so an action can only follow a failure that counted.
        `SELECT id, is_required, is_critical, prompt, qtype, allow_na, photo_rule, note_rule,
                section_id, sort_order, raise_ca_on_fail, ca_severity
           FROM fssai_questions
          WHERE template_id = ? AND is_active = 1 ORDER BY sort_order ASC`,
      ).all(run.template_id) as any[];
      const responses = db.prepare(`SELECT * FROM fssai_responses WHERE run_id = ?`).all(runId) as any[];
      const byQ = new Map(responses.map((r) => [String(r.question_id), r]));
      const evidence = evidenceCountsByQuestion(db, runId);
      const liveIds = new Set(liveQuestions.map((q) => String(q.id)));

      const answeredElsewhereIds = responses
        .map((r) => String(r.question_id))
        .filter((qid) => !liveIds.has(qid));
      const retiredAnswered: any[] = [];
      if (answeredElsewhereIds.length) {
        const rows = db.prepare(
          `SELECT id, is_required, is_critical, prompt, qtype, allow_na, photo_rule, note_rule,
                  section_id, sort_order, raise_ca_on_fail, ca_severity
             FROM fssai_questions
            WHERE id IN (${answeredElsewhereIds.map(() => '?').join(',')})`,
        ).all(...answeredElsewhereIds) as any[];
        const found = new Map(rows.map((x) => [String(x.id), x]));
        for (const qid of answeredElsewhereIds) {
          const r = byQ.get(qid);
          if (!r) continue;
          const row = found.get(qid);
          // A question row that has vanished entirely (it cannot, while a
          // response references it — the FK is declared — but a record must
          // still add up if it ever does) is rebuilt from the frozen response.
          retiredAnswered.push(row || {
            id: qid, is_required: 0, is_critical: 0, prompt: r.prompt_snapshot || '(question removed)',
            qtype: r.qtype, allow_na: 1, photo_rule: 'never', note_rule: 'never',
            section_id: null, sort_order: r.sort_order ?? 0,
            // Nothing survives to say this question wanted a corrective action,
            // so it does not claim one. An honest 0, not a guess.
            raise_ca_on_fail: 0, ca_severity: 'medium',
          });
        }
      }
      const judged = [...liveQuestions, ...retiredAnswered];

      // Only a question STILL ON THE SHEET can block submission: a retired one
      // is off the sheet, and every retired one here already carries an answer.
      const missing = liveQuestions
        .map((q) => ({ q, state: answerComplete(q, byQ.get(String(q.id)), evidence.get(String(q.id)) || 0) }))
        .filter(({ q, state }) => Number(q.is_required) && !state.answered);
      if (missing.length) {
        return Response.json(
          {
            error: `${missing.length} question${missing.length === 1 ? '' : 's'} still need${missing.length === 1 ? 's' : ''} an answer before this check can be submitted.`,
            missing: missing.map(({ q, state }) => ({ question_id: q.id, prompt: q.prompt, reason: state.reason })),
          },
          { status: 400 },
        );
      }

      /* ── THE SIGNATURE GATE (P3) ──────────────────────────────────────────
       * ⚠️ CONTRACT CHANGE, AND THE REASON FOR IT. Until P3 this route WROTE a
       * signature by itself: `signed_by = me.email` whenever the checklist had
       * requires_signature, as a side effect of submitting. Nobody was ever
       * asked. An inspector reading "signed by chef@akan" would reasonably
       * believe a person attested to those readings; in fact the server typed the
       * line the moment the last box was ticked, and there was no act to
       * repudiate. `requires_signature` DEFAULTS TO 1, so that was every record.
       *
       * Now the person presses Sign (POST /api/fssai/sign), which records who,
       * when, the statement in words, and a SHA-256 of the answers and photographs
       * as they then stood. Submit refuses without it, and refuses again if an
       * answer changed after signing — otherwise the attestation would cover
       * words it never saw. Both refusals are machine-readable and name the
       * endpoint, because a runner that meets one must know what to do next.
       *
       * A checklist with requires_signature = 0 submits exactly as it did before.
       * This is the owner's own §22 order of work: Readings → Photo → Remarks →
       * SIGN → Submit. */
      let signatureForRecord: ReturnType<typeof fssaiSignatureState>['signature'] = null;
      /* TWO WAYS TO HAVE SIGNED, one act. `sign:true` in the submit body is the
       * phone's one-tap "Sign and submit": the person was shown the statement and
       * pressed one button, so the signature is written (by the SAME helper, with
       * the same digest and the same audit row) immediately before the record is
       * frozen, inside the submit transaction below. The two-step path — POST
       * /api/fssai/sign, look at the sheet again, then submit — is protected by the
       * staleness test instead. What is NOT possible any more is the third thing:
       * the server signing because nobody asked. */
      const askedToSign = body?.sign === true || body?.sign === 1 || body?.sign === '1';
      const signStatement = fssaiSignatureStatement(str(body?.signature_statement));
      /* WHETHER AN UNSIGNED CHECK IS REFUSED OR ATTESTED ON THE SPOT — the
       * reasoning, and how to tighten it, is written out in full at
       * FSSAI_REQUIRE_EXPLICIT_SIGNATURE. In short: refusing would mean the owner's
       * first tap on "Sign and submit" at the review gate met an error about the
       * button he had just pressed, because the runner does not send sign:true yet.
       * So the act is performed and its MODE is recorded, and every screen says
       * which kind of attestation it was. */
      const signNow = askedToSign || !FSSAI_REQUIRE_EXPLICIT_SIGNATURE;
      /* WHICH KIND OF ATTESTATION THIS IS — owner Q17, and the record must say
       * so honestly.
       *
       * This line was hardcoded `'on_submit'`. There are TWO ways to reach the
       * sign call below, and only one of them is a button press:
       *   · askedToSign  → the client showed the statement and the person tapped
       *                    "Sign and submit". That is 'on_submit', and it was
       *                    always correct.
       *   · !askedToSign → nobody was asked ANYTHING. The strict gate is off, so
       *                    the server attests by itself. Recording that as
       *                    'on_submit' made /fssai/verification print "signed by
       *                    pressing “Sign and submit”" about a button that was
       *                    never on screen.
       * The two-step path (POST /api/fssai/sign first) never reaches this line at
       * all — its signature is carried in via signatureForRecord below and keeps
       * the 'explicit' mode the sign route wrote. */
      const signMode: FssaiSignatureMode = askedToSign ? 'on_submit' : 'not_asked';
      if (Number(tpl.requires_signature)) {
        const sig = fssaiSignatureState(db, runId);
        if (!sig.is_signed && !signNow) {
          return Response.json(
            {
              error: 'This check has to be signed before it can be submitted. Read the statement, then sign it.',
              code: 'signature_required',
              sign_endpoint: '/api/fssai/sign',
              // Or send the same submit again with sign:true, having shown this
              // sentence to the person first.
              sign_inline: { action: 'submit', sign: true },
              statement: FSSAI_SIGNATURE_STATEMENT,
            },
            { status: 400 },
          );
        }
        if (sig.is_stale && !signNow) {
          return Response.json(
            {
              error: 'Something changed after you signed, so the signature no longer covers what is on the sheet. Check the answers and sign again.',
              code: 'signature_stale',
              sign_endpoint: '/api/fssai/sign',
              statement: FSSAI_SIGNATURE_STATEMENT,
              signed_at: sig.signature?.signed_at || '',
              // What it covered, against what is there now — so the screen can
              // say "you have added a photograph since" rather than just "stale".
              signed_answers: sig.signature?.answers ?? 0,
              signed_photos: sig.signature?.photos ?? 0,
              answers_now: sig.answers_now,
              photos_now: sig.photos_now,
            },
            { status: 400 },
          );
        }
        /* ONLY A SIGNATURE THAT STILL COVERS THE SHEET IS CARRIED INTO THE RECORD.
         * A stale one is dropped here and re-taken inside the transaction below —
         * because freezing an attestation whose digest does not match the answers
         * it is stapled to would be worse than having none: it would look verified
         * and prove nothing. (Without this line a stale signature reached the
         * record intact whenever the strict gate was off.) */
        signatureForRecord = sig.is_signed && !sig.is_stale ? sig.signature : null;
      }

      const facts = judged.map((q) => {
        const r = byQ.get(String(q.id));
        return {
          is_fail: r ? r.is_fail : 0,
          is_na: r ? r.is_na : 0,
          answered: r ? answerComplete(q, r, evidence.get(String(q.id)) || 0).answered : false,
        };
      });
      const criticalFailed = judged.some((q) => Number(q.is_critical) && Number(byQ.get(String(q.id))?.is_fail || 0));
      const summary = summariseFssaiRun(facts, Number(tpl.pass_threshold_pct ?? 100), criticalFailed);

      const versionDrifted = Number(tpl.version) !== Number(run.template_version);

      /* THE SHEET AS IT WAS ASKED — frozen with the record (see
       * writeFssaiRecordSnapshot). This is what lets a finished record name the
       * questions that were SKIPPED, keep the title it was taken under, and say
       * which versions it spans, none of which fssai_responses can express. */
      const sheet: FssaiRecordSnapshotQuestion[] = judged.map((q) => {
        const r = byQ.get(String(q.id));
        return {
          question_id: String(q.id),
          prompt: String(q.prompt ?? ''),
          qtype: String(r?.qtype || q.qtype || ''),
          section_id: q.section_id ?? null,
          sort_order: Number(q.sort_order ?? 0),
          is_required: Number(q.is_required) ? 1 : 0,
          is_critical: Number(q.is_critical) ? 1 : 0,
          answered: r ? answerComplete(q, r, evidence.get(String(q.id)) || 0).answered : false,
          is_na: r && Number(r.is_na) ? 1 : 0,
          is_fail: r && Number(r.is_fail) ? 1 : 0,
          ...(liveIds.has(String(q.id)) ? {} : { retired_mid_run: true }),
        };
      });

      // Filled inside the transaction below; read after it commits, so the
      // response can only name actions that are actually in the file.
      let raisedActions: FssaiCaRaised[] = [];
      const submit = db.transaction(() => {
        /* THE ONE-TAP SIGN, inside the same transaction as the freeze, so the
         * digest covers the sheet exactly as it is about to be recorded and the
         * two writes cannot be separated by anything. */
        if (Number(tpl.requires_signature) && signNow && !signatureForRecord) {
          signatureForRecord = signFssaiRun(
            db, runId, run, { email: me.email, name: me.name }, signStatement, run.outlet_id, signMode,
          );
        }
        const res = db.prepare(
          `UPDATE fssai_runs
              SET status='submitted', submitted_at=datetime('now'),
                  total_count=?, answered_count=?, fail_count=?, na_count=?, pass_pct=?, outcome=?,
                  template_version=?, remarks=?,
                  signed_by=?, signed_at=?, updated_at=datetime('now')
            WHERE id=? AND status='in_progress'`,
        ).run(
          summary.total_count, summary.answered_count, summary.fail_count, summary.na_count,
          summary.pass_pct, summary.outcome,
          // The version ACTUALLY answered against. The audit row below keeps
          // the version it was started on, so the record is honest either way.
          tpl.version,
          str(body?.remarks),
          /* §7 Q6 (PROVISIONAL): a signature is the authenticated user plus a
           * timestamp, no drawing — but it is now the one RECORDED BY THE SIGN
           * ACT above, not one invented here. A checklist that does not require a
           * signature keeps '' rather than being given a signature nobody asked
           * for. `signed_by` is re-stated here (rather than left to the sign
           * route's own UPDATE) so the submitted row is self-consistent even if
           * the two writes were ever separated. */
          signatureForRecord ? signatureForRecord.signed_by : '',
          signatureForRecord ? signatureForRecord.signed_at : '',
          runId,
        );
        if (res.changes !== 1) throw new Error('FSSAI_RUN_ALREADY_SUBMITTED');

        if (versionDrifted) {
          // The template was edited while this round was being filled in. The
          // record says what was answered; this row preserves what was started.
          fssaiAuditBestEffort(db, {
            entity_table: 'fssai_runs', entity_id: runId, action: 'update', field: 'template_version',
            before: { template_version: run.template_version },
            after: { template_version: tpl.version },
            reason: 'The checklist was edited while this check was open',
            actor: { email: me.email, name: me.name }, outlet_id: run.outlet_id,
          });
        }
        fssaiAuditBestEffort(db, {
          entity_table: 'fssai_runs', entity_id: runId, action: 'submit',
          before: { status: 'in_progress' },
          after: { status: 'submitted', ...summary, template_version: tpl.version },
          actor: { email: me.email, name: me.name }, outlet_id: run.outlet_id,
        });
        writeFssaiRecordSnapshot(
          db,
          runId,
          {
            template: {
              id: String(tpl.id),
              name: String(tpl.name ?? ''),
              code: String(tpl.code ?? ''),
              version_at_open: Number(run.template_version ?? 0),
              version_at_submit: Number(tpl.version ?? 0),
              answered_across_versions: versionDrifted,
              pass_threshold_pct: Number(tpl.pass_threshold_pct ?? 100),
              requires_signature: Number(tpl.requires_signature) ? 1 : 0,
              requires_verification: Number(tpl.requires_verification) ? 1 : 0,
              frequency: String(tpl.frequency ?? ''),
              module_key: String(tpl.module_key ?? ''),
              department_id: String(tpl.department_id ?? ''),
            },
            sheet,
            counts: { ...summary, retired_mid_run: retiredAnswered.length },
            /* THE ATTESTATION, FROZEN WITH THE SHEET IT COVERS. The digest is
             * copied in here deliberately: a reader of the finished record can
             * recompute it over the record's own answers and see that nothing
             * moved, without trusting a second audit row to still be readable. */
            signature: signatureForRecord,
          },
          { email: me.email, name: me.name },
          run.outlet_id,
        );

        /* ── CORRECTIVE ACTIONS — owner Q14, and the whole of it ─────────────
         * LAST inside the transaction, after the record is frozen, so an action
         * can never exist against a record that was not recorded.
         *
         * It is raised from `judged` — the same list the verdict was built from,
         * live questions plus any retired mid-round — so an action can only
         * follow a failure that COUNTED. And it reads `is_fail` off the frozen
         * response rather than re-judging anything.
         *
         * THE FAILURE STANDS. Nothing in here touches this run: the summary
         * above is already written, and raiseFssaiCorrectiveActions writes to
         * one table only. The action is the follow-up hanging off the failure,
         * never a way of undoing it. */
        raisedActions = raiseFssaiCorrectiveActions(db, {
          runId,
          run: {
            business_date: run.business_date, department_id: run.department_id,
            equipment_id: run.equipment_id, target_label: run.target_label,
            shift: run.shift, outlet_id: run.outlet_id,
          },
          questions: judged,
          templateName: String(tpl.name ?? ''),
          actor: { email: me.email, name: me.name },
          outletId: run.outlet_id || outletId,
        });
      });
      try { submit(); } catch (e: any) {
        if (String(e?.message) === 'FSSAI_RUN_ALREADY_SUBMITTED') {
          return Response.json({ error: 'That check has already been submitted.' }, { status: 409 });
        }
        throw e;
      }
      fssaiAppAudit(db, {
        event_type: 'fssai.run.submit', entity_type: 'fssai_runs', entity_id: runId,
        actor_email: me.email, after: { outcome: summary.outcome, pass_pct: summary.pass_pct },
      });
      return Response.json({
        run: db.prepare(`SELECT * FROM fssai_runs WHERE id = ?`).get(runId),
        summary,
        template_edited_while_open: versionDrifted,
        template_version_at_open: Number(run.template_version ?? 0),
        template_version_at_submit: Number(tpl.version ?? 0),
        // Say out loud when a question was switched off mid-round and its answer
        // was still counted — silence is how the failure used to disappear.
        counted_retired_questions: retiredAnswered.length,
        retired_mid_run: retiredAnswered.map((q) => ({ question_id: q.id, prompt: q.prompt })),
        sheet_as_asked: sheet,
        // Who attested, and to what — so the "submitted" screen can show it
        // without a second request.
        signature: signatureForRecord,
        awaiting_verification: !!Number(tpl.requires_verification),
        /* WHAT NOW HAS TO BE FIXED (owner Q14). Said in the submit response so
         * the phone can tell the person before they put it down — an action
         * nobody hears about until somebody opens a queue is an action that sits
         * there. The record's own verdict is unchanged by any of these. */
        corrective_actions: raisedActions,
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * TAKEOVER — management, with a written reason. §7 Q12's escape hatch.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'takeover') {
      if (!canTakeOverFssaiRun(me)) {
        return Response.json({ error: 'Only a manager can hand a check over to someone else.' }, { status: 403 });
      }
      const runId = str(body?.run_id);
      const reason = str(body?.reason);
      if (!runId) return Response.json({ error: 'Which check? No id was sent.' }, { status: 400 });
      if (!reason) return Response.json({ error: 'Say why this check is being taken over.' }, { status: 400 });

      const run = db.prepare(`SELECT * FROM fssai_runs WHERE id = ?`).get(runId) as any;
      if (!run) return Response.json({ error: 'That check no longer exists.' }, { status: 404 });
      if (run.status !== 'in_progress') {
        return Response.json({ error: 'That check is not open, so there is nothing to take over.' }, { status: 409 });
      }
      if (String(run.recorded_by || '').toLowerCase() === String(me.email || '').toLowerCase()) {
        return Response.json({ error: 'That check is already yours.' }, { status: 409 });
      }

      const take = db.transaction(() => {
        const res = db.prepare(
          `UPDATE fssai_runs SET recorded_by=?, recorded_name=?, updated_at=datetime('now')
            WHERE id=? AND status='in_progress'`,
        ).run(me.email || '', me.name || '', runId);
        if (res.changes !== 1) throw new Error('FSSAI_RUN_NOT_OPEN');
        // Answers already given keep their own answered_by, so the sheet still
        // shows who answered what.
        fssaiAudit(db, {
          entity_table: 'fssai_runs', entity_id: runId, action: 'update', field: 'recorded_by',
          before: { recorded_by: run.recorded_by, recorded_name: run.recorded_name },
          after: { recorded_by: me.email, recorded_name: me.name },
          reason,
          actor: { email: me.email, name: me.name }, outlet_id: run.outlet_id,
        });
      });
      try { take(); } catch (e: any) {
        if (String(e?.message) === 'FSSAI_RUN_NOT_OPEN') {
          return Response.json({ error: 'That check is no longer open.' }, { status: 409 });
        }
        throw e;
      }
      return Response.json({ run: db.prepare(`SELECT * FROM fssai_runs WHERE id = ?`).get(runId) });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * VOID — owner §19: a compliance record is voided with a mandatory
     * reason, never deleted. A voided run does NOT block the slot, because it
     * never happened.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'void') {
      if (!canTakeOverFssaiRun(me)) {
        return Response.json({ error: 'Only a manager can void a recorded check.' }, { status: 403 });
      }
      const runId = str(body?.run_id);
      const reason = str(body?.reason);
      if (!runId) return Response.json({ error: 'Which check? No id was sent.' }, { status: 400 });
      if (!reason) return Response.json({ error: 'A voided check must say why. Type the reason.' }, { status: 400 });

      const run = db.prepare(`SELECT * FROM fssai_runs WHERE id = ?`).get(runId) as any;
      if (!run) return Response.json({ error: 'That check no longer exists.' }, { status: 404 });
      if (run.status === 'void') return Response.json({ error: 'That check is already void.' }, { status: 409 });

      const voidIt = db.transaction(() => {
        const res = db.prepare(
          `UPDATE fssai_runs SET status='void', voided_at=datetime('now'), voided_by=?, void_reason=?,
                  updated_at=datetime('now')
            WHERE id=? AND status <> 'void'`,
        ).run(me.email || '', reason, runId);
        if (res.changes !== 1) throw new Error('FSSAI_RUN_ALREADY_VOID');
        fssaiAudit(db, {
          entity_table: 'fssai_runs', entity_id: runId, action: 'void', field: 'status',
          before: { status: run.status, outcome: run.outcome, pass_pct: run.pass_pct },
          after: { status: 'void' }, reason,
          actor: { email: me.email, name: me.name }, outlet_id: run.outlet_id,
        });
      });
      try { voidIt(); } catch (e: any) {
        if (String(e?.message) === 'FSSAI_RUN_ALREADY_VOID') {
          return Response.json({ error: 'That check is already void.' }, { status: 409 });
        }
        throw e;
      }
      fssaiAppAudit(db, {
        event_type: 'fssai.run.void', entity_type: 'fssai_runs', entity_id: runId,
        actor_email: me.email, before: { status: run.status }, after: { status: 'void' }, note: reason,
      });
      return Response.json({ run: db.prepare(`SELECT * FROM fssai_runs WHERE id = ?`).get(runId) });
    }

    return Response.json(
      { error: `"${action}" is not something that can be done to a check. Use open, answer, submit, takeover or void.` },
      { status: 400 },
    );
  } catch (e: any) {
    const nice = constraintMessage(e, 'That check could not be saved.');
    if (nice) return Response.json({ error: nice }, { status: 409 });
    console.error('POST /api/fssai/runs failed:', e);
    return Response.json({ error: e?.message || 'Failed to record the check' }, { status: 500 });
  }
}
