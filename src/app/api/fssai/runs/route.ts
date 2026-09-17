/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, isManagement } from '@/lib/auth';
import {
  canRunFssaiCheck, canTakeOverFssaiRun, decideFssaiSlot, evaluateFssaiAnswer,
  summariseFssaiRun, fssaiToday, isISODate, daysBetweenISO, isFssaiShift, isFssaiTargetKind,
  type FssaiSlotRunRow,
} from '@/lib/fssai';
import {
  requireFssaiUser, fssaiAudit, fssaiAuditBestEffort, fssaiAppAudit, parseJsonArray,
  shapeQuestion, str, constraintMessage,
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

/** An answered response is one that carries a value or is marked N/A. */
function isAnswered(r: any): boolean {
  if (Number(r.is_na)) return true;
  if (r.value_bool !== null && r.value_bool !== undefined) return true;
  if (r.value_num !== null && r.value_num !== undefined) return true;
  return String(r.value_text || '') !== '';
}

/** May this person read this run? (§7 Q10 provisional: own + own department; management sees all.) */
function canSeeRun(me: any, run: any): boolean {
  if (isManagement(me)) return true;
  if (String(run.recorded_by || '').toLowerCase() === String(me.email || '').toLowerCase()) return true;
  return !!run.department_id && run.department_id === me.department_id;
}

/** The two rows the slot decision needs, read with ONE predicate everywhere. */
function readSlot(db: any, slot: { template_id: string; business_date: string; target_id: string; shift: string }) {
  const openRun = db.prepare(
    `SELECT id, status, recorded_by, recorded_name, started_at, answered_count, total_count
       FROM fssai_runs
      WHERE template_id=? AND business_date=? AND IFNULL(target_id,'')=? AND IFNULL(shift,'')=?
        AND status='in_progress'
      LIMIT 1`,
  ).get(slot.template_id, slot.business_date, slot.target_id, slot.shift) as FssaiSlotRunRow | undefined;

  const decidedRun = db.prepare(
    `SELECT id, status, recorded_by, recorded_name, submitted_at, answered_count, total_count
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
      return Response.json({ slot, decision });
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
        return Response.json({
          run,
          template: tpl ? { id: tpl.id, name: tpl.name, code: tpl.code, current_version: tpl.version } : null,
          responses,
          questions: null,
          rendered_from: 'responses',
          template_version_at_record: run.template_version,
          template_version_now: tpl ? tpl.version : null,
          edited_since: !!tpl && Number(tpl.version) !== Number(run.template_version),
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
      if (mine) { where.push('lower(r.recorded_by) = lower(?)'); args.push(me.email || ' '); }
      else {
        where.push(`(lower(r.recorded_by) = lower(?) OR (r.department_id <> '' AND r.department_id = ?))`);
        args.push(me.email || ' ', me.department_id || ' ');
      }
    }
    const runs = db.prepare(
      `SELECT r.*, t.name AS template_name
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
        return Response.json(
          { error: `"${tpl.name}" has not been published yet, so it cannot be run. Ask an administrator to publish it.` },
          { status: 409 },
        );
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
          { error: decision.message, code: decision.code, run_id: decision.run_id, decision },
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
        return Response.json({ error: 'That question has been switched off since this check was started.' }, { status: 409 });
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
      const valueBool = rawBool === undefined || rawBool === null || String(rawBool).trim() === ''
        ? null
        : (rawBool === true || rawBool === 1 || String(rawBool) === '1' || String(rawBool).toLowerCase() === 'true' ? 1 : 0);
      const valueText = str(body?.value_text);
      const isNa = body?.is_na === true || body?.is_na === 1 || String(body?.is_na) === '1';
      if (isNa && !Number(q.allow_na)) {
        return Response.json({ error: 'This question cannot be marked not-applicable.' }, { status: 400 });
      }
      if (q.qtype === 'multiple_choice' && valueText) {
        const opts = parseJsonArray(q.options_json);
        if (!opts.includes(valueText)) {
          return Response.json({ error: `"${valueText}" is not one of the answers on the list.` }, { status: 400 });
        }
      }

      const evidenceCount = (db.prepare(
        `SELECT COUNT(*) AS n FROM fssai_evidence WHERE run_id = ? AND response_id IN
           (SELECT id FROM fssai_responses WHERE run_id = ? AND question_id = ?)`,
      ).get(runId, runId, questionId) as any).n as number;

      const verdict = evaluateFssaiAnswer(
        {
          qtype: q.qtype, is_required: q.is_required, allow_na: q.allow_na,
          min_value: q.min_value, max_value: q.max_value, expected_value: q.expected_value,
          fail_options: parseJsonArray(q.fail_options_json), photo_rule: q.photo_rule,
        },
        {
          value_text: q.qtype === 'signature' ? (valueText || me.email || '') : valueText,
          value_num: valueNum, value_bool: valueBool === null ? null : !!valueBool,
          is_na: isNa, evidence_count: evidenceCount,
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
          q.min_value, q.max_value, q.expected_value, q.uom, str(body?.note),
          me.email || '', outletId,
        );
        const rows = db.prepare(`SELECT * FROM fssai_responses WHERE run_id = ?`).all(runId) as any[];
        const answered = rows.filter(isAnswered).length;
        db.prepare(
          `UPDATE fssai_runs SET answered_count=?, updated_at=datetime('now') WHERE id=? AND status='in_progress'`,
        ).run(answered, runId);
        return answered;
      });
      const answered = save();
      const response = db.prepare(`SELECT * FROM fssai_responses WHERE run_id = ? AND question_id = ?`).get(runId, questionId);
      return Response.json({ response, verdict, answered_count: answered });
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

      const questions = db.prepare(
        `SELECT id, is_required, is_critical, prompt FROM fssai_questions
          WHERE template_id = ? AND is_active = 1 ORDER BY sort_order ASC`,
      ).all(run.template_id) as any[];
      const responses = db.prepare(`SELECT * FROM fssai_responses WHERE run_id = ?`).all(runId) as any[];
      const byQ = new Map(responses.map((r) => [r.question_id, r]));

      const missing = questions.filter((q) => {
        if (!Number(q.is_required)) return false;
        const r = byQ.get(q.id);
        return !r || !isAnswered(r);
      });
      if (missing.length) {
        return Response.json(
          {
            error: `${missing.length} question${missing.length === 1 ? '' : 's'} still need${missing.length === 1 ? 's' : ''} an answer before this check can be submitted.`,
            missing: missing.map((q) => ({ question_id: q.id, prompt: q.prompt })),
          },
          { status: 400 },
        );
      }

      const facts = questions.map((q) => {
        const r = byQ.get(q.id);
        return { is_fail: r ? r.is_fail : 0, is_na: r ? r.is_na : 0, answered: r ? isAnswered(r) : false };
      });
      const criticalFailed = questions.some((q) => Number(q.is_critical) && Number(byQ.get(q.id)?.is_fail || 0));
      const summary = summariseFssaiRun(facts, Number(tpl.pass_threshold_pct ?? 100), criticalFailed);

      const versionDrifted = Number(tpl.version) !== Number(run.template_version);

      const submit = db.transaction(() => {
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
          // §7 Q6 (PROVISIONAL): a signature is the authenticated user plus a
          // timestamp. No drawing.
          Number(tpl.requires_signature) ? (me.email || '') : '',
          Number(tpl.requires_signature) ? new Date().toISOString() : '',
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
