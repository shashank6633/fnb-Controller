/**
 * FSSAI Compliance — server-side helpers shared by every /api/fssai route.
 *
 * SERVER ONLY. This module imports the database; the pure vocabulary that both
 * the server and the screens share lives in src/lib/fssai.ts and must stay
 * free of a DB import.
 *
 * What lives here and why it is not repeated in eight route files:
 *   · the two gates (admin author / any signed-in reader), returning the house
 *     `{ me } | { resp }` shape so a handler needs one line;
 *   · the module-local audit writer, which is the ONLY thing that satisfies
 *     owner §19 ("original value, changed value, REASON") — logAuditEvent
 *     never throws and has no reason column, so it cannot be the compliance
 *     trail on its own (db.ts, the fssai_audit_log comment);
 *   · one loader for a template with its ordered sections and questions, used
 *     by create / read / update / duplicate alike, so all four return exactly
 *     the same shape;
 *   · the version bump, in ONE place, so no route can forget it.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, isManagement, type SessionUser } from '@/lib/auth';
import {
  canAuthorFssai, evaluateFssaiAnswer, qtypeMeta, fssaiSignatureModeFrom,
  fssaiAnswerInWords, fssaiCaDueDate, fssaiCaIsOverdue, fssaiCaSeverityMeta,
  fssaiCaStatusMeta, fssaiToday, isFssaiCaSeverity,
  type FssaiSignature, type FssaiSignatureMode,
} from '@/lib/fssai';

export type Gate = { me: SessionUser } | { resp: Response };

/**
 * THE AUTHORING GATE — admin only (owner §20: only the administrator
 * configures). Every mutating /api/fssai authoring handler opens with this.
 *
 * proxy.ts guards PAGES, not APIs (proxy.ts:181), and canAccessPage fails
 * OPEN four ways, so this — not the page catalog — is the gate that holds.
 */
export async function requireFssaiAdmin(): Promise<Gate> {
  const me = await getCurrentUser();
  if (!me) return { resp: Response.json({ error: 'Sign in required' }, { status: 401 }) };
  if (!canAuthorFssai(me)) {
    return {
      resp: Response.json(
        { error: 'Only an administrator can set up food-safety checklists.' },
        { status: 403 },
      ),
    };
  }
  return { me };
}

/** THE READ GATE — any signed-in user. Staff run the checks. */
export async function requireFssaiUser(): Promise<Gate> {
  const me = await getCurrentUser();
  if (!me) return { resp: Response.json({ error: 'Sign in required' }, { status: 401 }) };
  return { me };
}

/* ------------------------------------------------------------------ *
 * CSRF — the belt to the proxy's braces, for dynamic-segment routes
 * ------------------------------------------------------------------ */

const CSRF_COOKIE = 'fnb_csrf';
const CSRF_HEADER = 'x-csrf-token';

/**
 * RE-CHECK THE CSRF PAIR INSIDE THE HANDLER.
 *
 * MEASURED DEFECT (P2 adversarial probe). proxy.ts treats any pathname
 * containing '/print' as PUBLIC (proxy.ts:135) and any pathname ending .json /
 * .png / … likewise (:151), and it decides that BEFORE routing — so on the one
 * FSSAI route with a caller-controlled path segment,
 * `POST /api/fssai/templates/print-abc` reached the handler with NO CSRF token
 * while `POST /api/fssai/templates` was correctly refused 403. The same bypass
 * exists app-wide (proved on the untouched `PUT /api/returns/print-abc`), so the
 * cause is not FSSAI's and proxy.ts is shared with three live lanes — which is
 * exactly why the fix lives HERE, in FSSAI's own file, and changes nothing
 * outside this module.
 *
 * Not exploitable today (the session cookie is httpOnly + sameSite:'lax', so a
 * cross-site POST carries no session and the route's own getCurrentUser() 401s)
 * — but P3 and P4 add run and evidence routes on dynamic segments that WRITE
 * compliance records, and defence in depth is the whole point of having two
 * checks. Idempotent with the middleware: when the proxy already checked, this
 * re-checks the same pair and agrees.
 *
 * Returns a 403 Response to return immediately, or null to carry on.
 */
export function fssaiCsrfGuard(request: Request): Response | null {
  const method = String(request.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  const header = request.headers.get(CSRF_HEADER);
  const cookieHeader = request.headers.get('cookie') || '';
  let cookieToken = '';
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === CSRF_COOKIE) {
      cookieToken = decodeURIComponent(part.slice(eq + 1).trim());
      break;
    }
  }
  if (!cookieToken || !header || cookieToken !== header) {
    // The proxy's exact words, so a user cannot tell which of the two refused.
    return Response.json(
      { error: 'CSRF token missing or mismatched. Refresh the page.' },
      { status: 403 },
    );
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Audit
 * ------------------------------------------------------------------ */

export interface FssaiAuditInput {
  entity_table: string;   // 'fssai_templates' | 'fssai_questions' | ...
  entity_id: string;
  action: string;         // create|update|submit|verify|reject|void|reopen|delete|delete_blocked
  field?: string;         // '' for a whole-row diff
  before?: unknown;
  after?: unknown;
  reason?: string;        // MANDATORY on void/backdate — enforced by the caller
  actor: { email?: string | null; name?: string | null };
  outlet_id?: string | null;
}

/**
 * Write the compliance audit row. THROWS on failure, deliberately: called
 * inside the same transaction as the change it describes, so an authoring
 * action that cannot be recorded is rolled back rather than applied silently.
 * Nothing a member of staff performed is at risk here — this path is the
 * admin's own configuration work, and he can retry.
 *
 * (§7 Q4 is about the opposite case — a CHECK staff really performed. For that
 * path use fssaiAuditBestEffort so the record is never lost.)
 */
export function fssaiAudit(db: Database.Database, p: FssaiAuditInput): void {
  db.prepare(
    `INSERT INTO fssai_audit_log
       (id, entity_table, entity_id, action, field, before_json, after_json, reason,
        actor_email, actor_name, outlet_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    generateId(),
    p.entity_table,
    p.entity_id,
    p.action,
    p.field || '',
    p.before === undefined ? '' : JSON.stringify(p.before),
    p.after === undefined ? '' : JSON.stringify(p.after),
    p.reason || '',
    p.actor.email || '',
    p.actor.name || '',
    p.outlet_id || '',
  );
}

/**
 * The same row, but never throwing — for a record a member of staff really
 * performed (§7 Q4 provisional default: save the check, do not lose it, and
 * shout in the log so the rot is visible).
 */
export function fssaiAuditBestEffort(db: Database.Database, p: FssaiAuditInput): void {
  try {
    fssaiAudit(db, p);
  } catch (e: any) {
    console.error('[fssai] AUDIT WRITE FAILED — the record was kept:', p.entity_table, p.entity_id, p.action, e?.message);
  }
}

/** Mirror into the app-wide trail too (RECON §5 row 13 — no second audit table). */
export function fssaiAppAudit(
  db: Database.Database,
  p: { event_type: string; entity_type: string; entity_id: string; actor_email?: string; before?: any; after?: any; note?: string },
): void {
  logAuditEvent(db, {
    event_type: p.event_type,
    entity_type: p.entity_type,
    entity_id: p.entity_id,
    actor_email: p.actor_email || '',
    before: p.before,
    after: p.after,
    note: p.note || '',
  });
}

/* ------------------------------------------------------------------ *
 * THE RECORD SNAPSHOT — the sheet as it was asked, frozen at submit
 * ------------------------------------------------------------------ */

/**
 * WHAT THIS FIXES, AND WHY IT IS AN AUDIT ROW RATHER THAN NEW COLUMNS.
 *
 * Two measured defects, one cause: a finished record froze the ANSWERS but not
 * the SHEET.
 *   1. The checklist's NAME and CODE were read live, so renaming a checklist
 *      re-labelled every record ever taken under it — and a rename does not bump
 *      the version, so nothing on screen even hinted at it.
 *   2. Only ANSWERED questions leave a row, so a record could not say what was
 *      on the sheet and left blank; once such a question was deleted (lawful —
 *      it had no answers) the record could not even name it.
 *
 * fssai_runs has no frozen-name column and fssai_responses has no row for an
 * unanswered question. Adding either is a migration on a table that will hold
 * audit history, i.e. the owner's call (HARD RULE 4 / §7 Q15). fssai_audit_log
 * already exists to hold exactly this kind of frozen JSON, so the sheet is
 * written there ONCE, at submit, inside the submit transaction, and the read
 * path renders the record from it. No schema change.
 *
 * It is written best-effort (§7 Q4: never lose a check a member of staff really
 * performed because a log row failed). A record with no snapshot — anything
 * submitted before this landed — reads exactly as it did before, with
 * template_name_source:'live' saying so.
 */
export interface FssaiRecordSnapshotQuestion {
  question_id: string;
  prompt: string;
  qtype: string;
  section_id?: string | null;
  sort_order?: number;
  is_required: 0 | 1;
  is_critical: 0 | 1;
  /** was there an answer on the sheet when it was submitted? */
  answered: boolean;
  is_na: 0 | 1;
  is_fail: 0 | 1;
  /** the admin switched this question off while the round was being filled in */
  retired_mid_run?: boolean;
}

export interface FssaiRecordSnapshot {
  template: {
    id: string;
    name: string;
    code: string;
    version_at_open: number;
    version_at_submit: number;
    answered_across_versions: boolean;
    pass_threshold_pct: number;
    requires_signature: 0 | 1;
    requires_verification: 0 | 1;
    frequency: string;
    module_key: string;
    department_id: string;
  };
  sheet: FssaiRecordSnapshotQuestion[];
  counts: Record<string, unknown>;
  /**
   * THE ATTESTATION, COPIED IN AT SUBMIT (P3). Optional because every record
   * submitted before P3 landed has none, and because a checklist may be
   * configured not to require one — an absent signature here means "this record
   * was never signed", which is a fact the record should be able to state, not a
   * hole to paper over.
   */
  signature?: FssaiSignature | null;
}

export const FSSAI_SNAPSHOT_ACTION = 'snapshot';

export function writeFssaiRecordSnapshot(
  db: Database.Database,
  runId: string,
  snap: FssaiRecordSnapshot,
  actor: { email?: string | null; name?: string | null },
  outletId?: string | null,
): void {
  fssaiAuditBestEffort(db, {
    entity_table: 'fssai_runs',
    entity_id: runId,
    action: FSSAI_SNAPSHOT_ACTION,
    field: 'record',
    after: snap,
    reason: 'The checklist as it was asked, frozen with the record',
    actor,
    outlet_id: outletId || '',
  });
}

/** The frozen sheet for one run, or null when there is none (or it is junk). */
export function readFssaiRecordSnapshot(db: Database.Database, runId: string): FssaiRecordSnapshot | null {
  const row = db.prepare(
    `SELECT after_json FROM fssai_audit_log
      WHERE entity_table='fssai_runs' AND entity_id=? AND action=?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(runId, FSSAI_SNAPSHOT_ACTION) as any;
  if (!row || !row.after_json) return null;
  try {
    const v = JSON.parse(String(row.after_json));
    if (!v || typeof v !== 'object' || !v.template) return null;
    if (!Array.isArray(v.sheet)) v.sheet = [];
    return v as FssaiRecordSnapshot;
  } catch {
    // A record must still render if its snapshot is unreadable.
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Loading a template
 * ------------------------------------------------------------------ */

export function parseJsonArray(text: unknown): string[] {
  try {
    const v = JSON.parse(String(text ?? '[]'));
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

/** One question row, shaped for the wire (JSON columns already parsed). */
export function shapeQuestion(row: any) {
  const meta = qtypeMeta(row.qtype);
  return {
    ...row,
    options: parseJsonArray(row.options_json),
    fail_options: parseJsonArray(row.fail_options_json),
    // null tells the screen (and P3's runner) that this template references a
    // type this build does not know — it must refuse to render it, never draw
    // a blank field (RECON §10 R1).
    qtype_label: meta ? meta.label : null,
    qtype_known: !!meta,
  };
}

export interface LoadTemplateOptions {
  /** include is_active = 0 sections/questions (the builder needs them). */
  includeRetired?: boolean;
}

/**
 * A template with its ordered sections and questions, plus the counts every
 * screen shows. ORDER BY sort_order ASC, created_at ASC — the tie-break
 * matters: two questions can legitimately share a sort_order.
 */
export function loadFssaiTemplate(db: Database.Database, id: string, opts: LoadTemplateOptions = {}) {
  const tpl = db.prepare(`SELECT * FROM fssai_templates WHERE id = ?`).get(id) as any;
  if (!tpl) return null;

  const secWhere = opts.includeRetired ? '' : ' AND is_active = 1';
  const qWhere = opts.includeRetired ? '' : ' AND is_active = 1';

  const sections = db
    .prepare(`SELECT * FROM fssai_sections WHERE template_id = ?${secWhere} ORDER BY sort_order ASC, created_at ASC`)
    .all(id) as any[];
  const questions = (db
    .prepare(`SELECT * FROM fssai_questions WHERE template_id = ?${qWhere} ORDER BY sort_order ASC, created_at ASC`)
    .all(id) as any[]).map(shapeQuestion);

  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM fssai_sections  WHERE template_id = ? AND is_active = 1) AS section_count,
         (SELECT COUNT(*) FROM fssai_questions WHERE template_id = ? AND is_active = 1) AS question_count,
         (SELECT COUNT(*) FROM fssai_runs      WHERE template_id = ?)                   AS run_count,
         (SELECT COUNT(*) FROM fssai_runs      WHERE template_id = ? AND status = 'in_progress') AS open_run_count,
         (SELECT COUNT(*) FROM fssai_assignments WHERE template_id = ? AND is_active = 1) AS assignment_count`,
    )
    .get(id, id, id, id, id) as any;

  return { ...tpl, sections, questions, ...counts };
}

/**
 * THE VERSION BUMP — one implementation, so no route can forget it.
 *
 * Copied from HRMS, which does exactly this at three call sites
 * (api/hr/tests/route.ts:316, :677, :825), always inside the same transaction
 * as the mutation: `UPDATE hr_tests SET version = version + 1`.
 *
 * What it protects: a run freezes fssai_runs.template_version at creation and
 * every ANSWER freezes its own prompt/qtype/uom/min_used/max_used/
 * expected_used/is_fail. So editing a template today can never rewrite what
 * was asked or judged last Tuesday. The counter is what makes the drift
 * VISIBLE (run.template_version ≠ template.version); the response snapshots
 * are what make it HARMLESS.
 *
 * Returns the new version number.
 */
export function bumpFssaiTemplateVersion(db: Database.Database, templateId: string): number {
  db.prepare(
    `UPDATE fssai_templates SET version = version + 1, updated_at = datetime('now') WHERE id = ?`,
  ).run(templateId);
  const row = db.prepare(`SELECT version FROM fssai_templates WHERE id = ?`).get(templateId) as any;
  return Number(row?.version ?? 0);
}

/** Touch updated_at without bumping the version (a cosmetic edit). */
export function touchFssaiTemplate(db: Database.Database, templateId: string): void {
  db.prepare(`UPDATE fssai_templates SET updated_at = datetime('now') WHERE id = ?`).run(templateId);
}

/* ------------------------------------------------------------------ *
 * RUNNING A CHECK — the four predicates the RUNNER and the EVIDENCE route
 * both need (P3)
 * ------------------------------------------------------------------ *
 *
 * WHY THESE LIVE HERE NOW. Attaching a photograph is not a second kind of
 * answer — it COMPLETES one. So the evidence route must reach exactly the same
 * conclusions as the answer route about (a) who may look at a run, (b) whether
 * an answer is finished, and (c) how many answers on this run are finished. If
 * it reaches different ones, a photograph could satisfy the runner's progress
 * bar and not the submit gate, which is the class of defect P2's fix round
 * spent itself on (two disagreeing definitions of "answered").
 *
 * ⚠️ HONEST NOTE ON DUPLICATION. `src/app/api/fssai/runs/route.ts` still holds
 * its own private copies of the first three (canSeeRun:116, answerComplete:71,
 * evidenceCountsByQuestion:96), written in P2a. These four are copied from
 * there deliberately — behaviour for behaviour — rather than editing that file,
 * because P2a's route is shared with other lanes working at the same time and a
 * clobbered engine costs more than a duplicated predicate. THEY MUST NOT DRIFT:
 * change one, change the other. Unifying them (delete the private copies, import
 * these) is a three-line edit and is listed for P11.
 */

/**
 * MAY THIS PERSON READ THIS RUN? (§7 Q10 provisional: own + own department;
 * management sees all; a run belonging to NO department belongs to the whole
 * restaurant and any signed-in member of staff may read it.)
 *
 * Verbatim from runs/route.ts:116 — see the note above.
 */
export function canSeeFssaiRun(
  me: { role?: string; is_head_chef?: boolean; email?: string | null; department_id?: string | null } | null,
  run: { recorded_by?: string | null; department_id?: string | null },
): boolean {
  if (!me) return false;
  if (isManagement(me)) return true;
  if (String(run.recorded_by || '').toLowerCase() === String(me.email || '').toLowerCase()) return true;
  if (!String(run.department_id || '')) return true;
  return !!run.department_id && run.department_id === me.department_id;
}

/** How many evidence rows hang off each answer in this run, by QUESTION id. */
export function fssaiEvidenceCountsByQuestion(db: Database.Database, runId: string): Map<string, number> {
  const rows = db.prepare(
    `SELECT r.question_id AS qid, COUNT(e.id) AS n
       FROM fssai_responses r LEFT JOIN fssai_evidence e ON e.response_id = r.id
      WHERE r.run_id = ? GROUP BY r.question_id`,
  ).all(runId) as any[];
  return new Map(rows.map((r) => [String(r.qid), Number(r.n) || 0]));
}

/**
 * IS THIS ANSWER FINISHED? — a value present AND whatever photograph or note the
 * question demands. Only `.answered` is taken from the evaluator: is_fail stays
 * frozen on the response row and is never recomputed on READ (RECON §10 R3).
 */
export function fssaiAnswerComplete(
  q: any,
  r: any,
  evidenceCount = 0,
): { answered: boolean; reason: string; needs_photo?: boolean; needs_note?: boolean } {
  if (!r) return { answered: false, reason: 'Not answered.' };
  const v = evaluateFssaiAnswer(
    {
      // The FROZEN type: judged complete as the type it was given under, even if
      // the live question has been changed since.
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
  return {
    answered: v.answered,
    reason: v.reason,
    ...(v.needs_photo ? { needs_photo: true } : {}),
    ...(v.needs_note ? { needs_note: true } : {}),
  };
}

/**
 * Recount the FINISHED answers on an open run and store the number.
 *
 * Identical arithmetic to the answer handler (runs/route.ts:570-582), so the
 * count a photograph moves and the count the submit gate reads are the same
 * number. Status-guarded: a run that has been submitted in the meantime is left
 * exactly as it was frozen.
 */
export function recomputeFssaiAnsweredCount(db: Database.Database, runId: string, templateId: string): number {
  const rows = db.prepare(`SELECT * FROM fssai_responses WHERE run_id = ?`).all(runId) as any[];
  const ev = fssaiEvidenceCountsByQuestion(db, runId);
  const liveQs = db.prepare(
    `SELECT id, qtype, is_required, allow_na, photo_rule, note_rule
       FROM fssai_questions WHERE template_id = ?`,
  ).all(templateId) as any[];
  const qById = new Map(liveQs.map((x) => [String(x.id), x]));
  const answered = rows.filter((r) =>
    fssaiAnswerComplete(qById.get(String(r.question_id)), r, ev.get(String(r.question_id)) || 0).answered,
  ).length;
  db.prepare(
    `UPDATE fssai_runs SET answered_count=?, updated_at=datetime('now') WHERE id=? AND status='in_progress'`,
  ).run(answered, runId);
  return answered;
}

/* ------------------------------------------------------------------ *
 * THE SIGNATURE — the act, the digest, and what the digest is for (P3)
 * ------------------------------------------------------------------ *
 *
 * §7 Q6 (PROVISIONAL DEFAULT — the owner has not ruled): a signature is the
 * authenticated user plus a timestamp. No drawing.
 *
 * WHAT P3 CHANGED, AND WHY IT MATTERS. P2a's submit STAMPED `signed_by` with the
 * submitter's own email as a side effect of submitting — the server invented a
 * signature nobody was asked for. A signature the software writes by itself is
 * exactly the thing an inspector should not be shown, because it attests to
 * nothing: there was no moment at which a person said "these are my answers".
 * So the act is now EXPLICIT (POST /api/fssai/sign) and submit REFUSES a
 * checklist that requires a signature until that act has happened.
 *
 * WHY A DIGEST. Signing an open sheet and then changing an answer would leave an
 * attestation attached to words it never covered. So the sign act records a
 * SHA-256 of every answer and every photograph as they stood at that moment; if
 * anything moves afterwards, submit refuses with `code:'signature_stale'` and the
 * person signs again, having seen what changed. That — an edit made THROUGH THE
 * APP after the attestation — is the entire non-repudiation claim. It is NOT
 * tamper-proofing: the digest lives in the same database as the data, so anyone
 * with write access to the file can recompute both. The four things a signature
 * does NOT prove are written out in full at src/lib/fssai.ts §11.
 *
 * WHERE IT IS STORED, with no schema change. `fssai_runs` already has
 * `signed_by` / `signed_at` (the two hot columns a list needs), and the digest,
 * the statement and the counts go into ONE `fssai_audit_log` row per act
 * (`action='sign'`) — the same pattern P2a's record snapshot uses, for the same
 * reason (§7 Q15: no migration on a table that holds audit history). At submit
 * the signature is copied INTO the record snapshot, so a finished record carries
 * its attestation even if the audit row is later unreadable.
 */

export const FSSAI_SIGN_ACTION = 'sign';
export const FSSAI_UNSIGN_ACTION = 'unsign';

/**
 * A SHA-256 over the answers and photographs of one run.
 *
 * DETERMINISTIC ON PURPOSE: rows are re-read in a fixed order (by question, then
 * by evidence id) and every field is stringified explicitly, so the same sheet
 * always produces the same digest and a re-ordered SELECT cannot invalidate a
 * signature by accident. `updated_at` is deliberately NOT in the digest — a
 * re-save that changes nothing a person can see must not break their signature.
 *
 * ── WHY `template_version` IS NOT IN THE DIGEST (measured defect) ──────────
 * It used to be, and it made the tamper indicator LIE on records nobody had
 * touched. `fssai_runs.template_version` is rewritten by submit — it is set to
 * the version actually answered against (runs/route.ts, the freeze UPDATE) —
 * while the signature is taken BEFORE that write, over the version the round was
 * opened on. So on any round where an administrator edited the checklist while
 * somebody was filling it in, the digest stored with the signature covered v_open
 * and the digest recomputed on read covered v_submit, and the verification screen
 * told a supervisor in red: "The signature no longer matches this record.
 * Something differs from what was signed." Nothing differed. Measured, one
 * variable: two identical rounds, the second with a mid-round question edit
 * (v2 → v3) and no answer touched — signature_intact came back TRUE and FALSE.
 * It could never be cleared, because a submitted record cannot be re-signed (409).
 *
 * A false alarm here is worse than no indicator at all: once this sentence is
 * known to fire on clean records, a real one cannot be told apart from it.
 *
 * So the digest covers exactly what the person attested to — every answer value,
 * its verdict, its note, and every photograph — bound to the run it belongs to.
 * The template VERSION is not something a signer attests to and it is not lost by
 * leaving it out: `template_version` sits on the run row, and the record snapshot
 * freezes `version_at_open` and `version_at_submit` separately and says out loud
 * when a round spans two (`answered_across_versions`). A template edit cannot
 * change a frozen fssai_responses row, so no answer is left unbound.
 */
export function computeFssaiSheetDigest(
  db: Database.Database,
  runId: string,
): { digest: string; answers: number; photos: number } {
  const run = db.prepare(
    `SELECT id, template_id FROM fssai_runs WHERE id = ?`,
  ).get(runId) as any;
  const responses = db.prepare(
    `SELECT question_id, qtype, value_text, value_num, value_bool, is_na, note, is_fail
       FROM fssai_responses WHERE run_id = ? ORDER BY question_id ASC`,
  ).all(runId) as any[];
  const photos = db.prepare(
    `SELECT id, response_id, mime, size_bytes FROM fssai_evidence
      WHERE run_id = ? ORDER BY id ASC`,
  ).all(runId) as any[];

  const h = createHash('sha256');
  h.update(`run:${String(run?.id ?? runId)}|tpl:${String(run?.template_id ?? '')}\n`);
  for (const r of responses) {
    h.update([
      'q', String(r.question_id ?? ''), String(r.qtype ?? ''),
      't', String(r.value_text ?? ''),
      'n', r.value_num === null || r.value_num === undefined ? '' : String(r.value_num),
      'b', r.value_bool === null || r.value_bool === undefined ? '' : String(Number(r.value_bool)),
      'na', String(Number(r.is_na) || 0),
      'note', String(r.note ?? ''),
      'fail', String(Number(r.is_fail) || 0),
    ].join('') + '\n');
  }
  for (const p of photos) {
    h.update(['p', String(p.id), String(p.response_id ?? ''), String(p.mime ?? ''), String(Number(p.size_bytes) || 0)].join('') + '\n');
  }
  return { digest: h.digest('hex'), answers: responses.length, photos: photos.length };
}

/** The signature as it was recorded, or null when this run has never been signed. */
export function readFssaiSignature(db: Database.Database, runId: string): FssaiSignature | null {
  const row = db.prepare(
    `SELECT after_json, created_at FROM fssai_audit_log
      WHERE entity_table='fssai_runs' AND entity_id=? AND action=?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(runId, FSSAI_SIGN_ACTION) as any;
  if (!row || !row.after_json) return null;
  try {
    const v = JSON.parse(String(row.after_json));
    if (!v || typeof v !== 'object' || !v.sheet_digest) return null;
    return {
      signed_by: String(v.signed_by ?? ''),
      signed_name: String(v.signed_name ?? ''),
      signed_at: String(v.signed_at ?? row.created_at ?? ''),
      statement: String(v.statement ?? ''),
      sheet_digest: String(v.sheet_digest ?? ''),
      answers: Number(v.answers) || 0,
      photos: Number(v.photos) || 0,
      /* NARROWED BY THE SHARED HELPER, NOT BY A TERNARY HERE.
       *
       * This line used to read `v.mode === 'on_submit' ? 'on_submit' : 'explicit'`,
       * which collapsed EVERY other value — including any value added to the enum
       * later — into 'explicit', the STRONGEST of the claims. Adding the
       * 'not_asked' mode without touching this line would have written a
       * signature saying "nobody was asked" and read it back as "signed as a
       * separate step, then submitted". fssaiSignatureModeFrom keeps the two
       * defaults that matter (absent → 'explicit' for a pre-mode row; present but
       * unrecognised → the weakest) in one place, so the next value added to the
       * enum cannot be silently promoted here. */
      mode: fssaiSignatureModeFrom(v.mode),
    };
  } catch {
    return null;
  }
}

/**
 * IS THIS RUN SIGNED, AND DOES THE SIGNATURE STILL COVER WHAT IT SAYS IT DOES?
 *
 * The one predicate the sign route, the submit gate and every screen share, so
 * "signed" cannot mean three different things in three places. A withdrawn
 * signature (`action='unsign'` written after the sign row) reads as unsigned.
 */
export function fssaiSignatureState(
  db: Database.Database,
  runId: string,
): {
  signature: FssaiSignature | null;
  is_signed: boolean;
  is_stale: boolean;
  digest_now: string;
  answers_now: number;
  photos_now: number;
} {
  const now = computeFssaiSheetDigest(db, runId);
  const sig = readFssaiSignature(db, runId);
  // A withdrawal is a row of its own, so the two acts are both in the file. The
  // LAST of the two wins.
  const withdrawn = db.prepare(
    `SELECT 1 FROM fssai_audit_log
      WHERE entity_table='fssai_runs' AND entity_id=? AND action=?
        AND (created_at, rowid) > (
          SELECT created_at, rowid FROM fssai_audit_log
           WHERE entity_table='fssai_runs' AND entity_id=? AND action=?
           ORDER BY created_at DESC, rowid DESC LIMIT 1)
      LIMIT 1`,
  ).get(runId, FSSAI_UNSIGN_ACTION, runId, FSSAI_SIGN_ACTION) as any;
  const live = sig && !withdrawn ? sig : null;
  return {
    signature: live,
    is_signed: !!live,
    is_stale: !!live && live.sheet_digest !== now.digest,
    digest_now: now.digest,
    answers_now: now.answers,
    photos_now: now.photos,
  };
}

/**
 * PERFORM THE SIGN ACT. The ONE place a signature is ever written.
 *
 * Two screens reach it and they must not drift:
 *   · POST /api/fssai/sign                       — sign, look again, then submit;
 *   · POST /api/fssai/runs {action:'submit', sign:true}
 *                                                — the phone's one-tap "Sign and
 *                                                  submit", signed immediately
 *                                                  before the record is frozen.
 *
 * WHY THE ONE-TAP PATH IS STILL AN EXPLICIT ACT, which is the whole point of P3:
 * the SERVER never decides to sign. It signs because the client said the person
 * pressed a button that showed them the statement. That is exactly as strong (and
 * exactly as weak) as a separate call to the sign route, which could equally be
 * made without showing anyone anything — and it is fundamentally different from
 * what P2a did, which was to write a signature whether or not any button existed.
 *
 * Caller's duty: be inside a transaction, and have already checked that the run
 * is open and belongs to this person. This function does not re-gate.
 */
export function signFssaiRun(
  db: Database.Database,
  runId: string,
  run: { signed_by?: string | null; signed_at?: string | null; outlet_id?: string | null },
  actor: { email?: string | null; name?: string | null },
  statement: string,
  outletId?: string | null,
  mode: FssaiSignatureMode = 'explicit',
): FssaiSignature {
  const { digest, answers, photos } = computeFssaiSheetDigest(db, runId);
  // The SERVER's clock, never the phone's: a device with the wrong time must not
  // be able to backdate an attestation.
  const signedAt = new Date().toISOString();
  const signature: FssaiSignature = {
    signed_by: actor.email || '',
    signed_name: actor.name || actor.email || '',
    signed_at: signedAt,
    statement,
    sheet_digest: digest,
    answers,
    photos,
    mode,
  };
  db.prepare(
    `UPDATE fssai_runs SET signed_by=?, signed_at=?, updated_at=datetime('now')
      WHERE id=? AND status='in_progress'`,
  ).run(signature.signed_by, signedAt, runId);
  /* Best-effort per §7 Q4 (never lose a check a member of staff really did), with
   * the consequence stated: if this row is lost, fssaiSignatureState reads the run
   * as UNSIGNED and submit asks for the signature again. It can never quietly
   * accept an attestation it cannot produce. */
  fssaiAuditBestEffort(db, {
    entity_table: 'fssai_runs', entity_id: runId, action: FSSAI_SIGN_ACTION, field: 'signed_by',
    before: { signed_by: run.signed_by || '', signed_at: run.signed_at || '' },
    after: signature,
    reason: statement,
    actor, outlet_id: outletId || run.outlet_id || '',
  });
  return signature;
}

/* ------------------------------------------------------------------ *
 * CORRECTIVE ACTIONS — owner §7 Q14
 * ------------------------------------------------------------------ */

/**
 * THE GAP THIS CLOSES, MEASURED BEFORE THE FIX.
 *
 * `fssai_questions.raise_ca_on_fail` has existed since P1. The admin can switch
 * it on per question, the builder shows it (`settings/checklists/[id]`), the
 * templates and questions routes store it and read it back — and it was read by
 * NOTHING that runs a check. Zero references in `api/fssai/runs/route.ts`.
 * `fssai_corrective_actions` was written by no route at all: an empty table with
 * a unique index on a number nothing minted.
 *
 * That is the inert-guard shape exactly: a setting that reads correctly, saves
 * correctly, displays correctly and NEVER FIRES. An admin who ticked "raise a
 * corrective action if this fails" got a tick mark and no corrective action.
 *
 * ── THE RULE THIS CODE EXISTS TO KEEP (owner Q14) ───────────────────────────
 * THE FAILURE STANDS. Raising an action must not — and here cannot — change
 * anything about the record that caused it. This function writes to exactly one
 * table. There is no UPDATE of fssai_runs, no UPDATE of fssai_responses, no
 * touch of status, outcome, pass_pct, fail_count or is_fail anywhere below.
 * Grep this section for `fssai_runs` and the only hit is the SELECT that reads
 * who recorded the check.
 */

/** 'CA-2026-0001' — the human-facing key, on the PINV / GRN / PROD model. */
export function nextFssaiCaNumber(db: Database.Database, isoDate: string): string {
  const year = /^\d{4}-/.test(String(isoDate || '')) ? String(isoDate).slice(0, 4) : String(new Date().getFullYear());
  // The house allocator (purchases/route.ts:587, returns.ts:155): MAX of the
  // numeric tail within the year's prefix. Called inside the caller's
  // transaction, so two checks submitted at the same moment cannot both read the
  // same MAX — and uq_fssai_ca_number is the backstop if they ever do.
  const last = db.prepare(
    `SELECT MAX(CAST(substr(ca_number, length('CA-' || ? || '-') + 1) AS INTEGER)) AS n
       FROM fssai_corrective_actions WHERE ca_number LIKE 'CA-' || ? || '-%'`,
  ).get(year, year) as any;
  return `CA-${year}-${String((Number(last?.n) || 0) + 1).padStart(4, '0')}`;
}

/** One question as the raiser needs to see it — live or retired mid-run. */
export interface FssaiCaRaiseQuestion {
  id: string;
  prompt?: string | null;
  raise_ca_on_fail?: unknown;
  ca_severity?: string | null;
  is_critical?: unknown;
}

/** What was raised, so the submit response can say so out loud. */
export interface FssaiCaRaised {
  id: string;
  ca_number: string;
  question_id: string;
  response_id: string;
  title: string;
  severity: string;
  due_date: string;
}

/**
 * RAISE AN ACTION FOR EVERY FAILED ANSWER WHOSE QUESTION ASKS FOR ONE.
 *
 * Called from inside the submit transaction, after the run row has been frozen,
 * so an action can never exist against a record that was not recorded.
 *
 * WHICH ANSWERS COUNT. The caller passes the questions the round was JUDGED on
 * — the live ones PLUS any retired while the round was open — which is the same
 * list the verdict is built from. A question switched off mid-round whose answer
 * still counts as a failure still raises its action: the failure is in the
 * record, so the follow-up belongs in the file too. A question row that has
 * vanished entirely is rebuilt by the caller with `raise_ca_on_fail` unset,
 * which reads as 0 — the honest answer, since nothing survives to say otherwise.
 *
 * `is_fail` is read STRAIGHT OFF THE FROZEN RESPONSE and never recomputed
 * (RECON §10 R3). An action is raised because the record says the answer failed,
 * not because this code re-judged it.
 *
 * IDEMPOTENT ON (run_id, response_id). Submit is status-guarded and runs once,
 * so this should never fire twice — but an action is a job somebody has to do,
 * and two of them for one failure is a real cost to a real person.
 *
 * BEST-EFFORT, DELIBERATELY, AND HERE IS THE TRADE. It is wrapped so a failure
 * to raise cannot roll back the submit: §7 Q4 says never lose a check a member
 * of staff really did, and a chef who has finished a round must not be told
 * "could not submit" because a follow-up row would not insert. The consequence
 * is stated rather than hidden — the action is missing, the FAILURE IS STILL
 * THERE ON THE RECORD in red, and the audit row below is what a reader checks.
 * Nothing about the record's own truth depends on this succeeding.
 */
export function raiseFssaiCorrectiveActions(
  db: Database.Database,
  input: {
    runId: string;
    run: {
      business_date?: string | null;
      department_id?: string | null;
      equipment_id?: string | null;
      target_label?: string | null;
      shift?: string | null;
      outlet_id?: string | null;
    };
    questions: FssaiCaRaiseQuestion[];
    templateName?: string | null;
    actor: { email?: string | null; name?: string | null };
    outletId?: string | null;
  },
): FssaiCaRaised[] {
  const { runId, run, questions, actor } = input;
  const raised: FssaiCaRaised[] = [];
  const wanted = questions.filter((q) => Number(q.raise_ca_on_fail) === 1);
  if (!wanted.length) return raised;

  try {
    const responses = db.prepare(
      `SELECT id, question_id, prompt_snapshot, qtype, value_text, value_num, value_bool,
              is_na, is_fail, uom, note
         FROM fssai_responses WHERE run_id = ?`,
    ).all(runId) as any[];
    const byQ = new Map(responses.map((r) => [String(r.question_id), r]));
    const outletId = input.outletId || run.outlet_id || '';
    const businessDate = String(run.business_date || '');
    const where = [String(run.target_label || ''), String(run.shift || '')].filter(Boolean).join(' · ');

    for (const q of wanted) {
      const r = byQ.get(String(q.id));
      if (!r || !Number(r.is_fail)) continue;   // no answer, or it did not fail

      const already = db.prepare(
        `SELECT id FROM fssai_corrective_actions WHERE run_id = ? AND response_id = ? LIMIT 1`,
      ).get(runId, String(r.id)) as any;
      if (already) continue;

      const prompt = String(q.prompt ?? r.prompt_snapshot ?? '').trim() || '(question removed)';
      const severity = isFssaiCaSeverity(q.ca_severity) ? q.ca_severity : 'medium';
      const answer = fssaiAnswerInWords(r);
      const uom = String(r.uom || '').trim();
      const id = generateId();
      const caNumber = nextFssaiCaNumber(db, businessDate);

      /* THE DESCRIPTION IS THE EVIDENCE, WRITTEN ONCE AND FROZEN. Whoever picks
       * this action up days later may not be able to open the record — they may
       * not even be in the right department — so the answer that caused it,
       * where it was taken and on what date travel WITH the action. */
      const description = [
        `${prompt} — recorded as “${answer}${uom ? ` ${uom}` : ''}”, which failed.`,
        input.templateName ? `Checklist: ${input.templateName}.` : '',
        businessDate ? `Recorded for ${businessDate}${where ? ` (${where})` : ''}.` : '',
        String(r.note || '').trim() ? `Note on the answer: “${String(r.note).trim()}”` : '',
      ].filter(Boolean).join(' ');

      db.prepare(
        `INSERT INTO fssai_corrective_actions
           (id, ca_number, source_kind, run_id, response_id, equipment_id, department_id,
            title, description, severity, status, owner_email, due_date, created_by, outlet_id)
         VALUES (?, ?, 'run', ?, ?, ?, ?, ?, ?, ?, 'open', '', ?, ?, ?)`,
      ).run(
        id, caNumber, runId, String(r.id),
        String(run.equipment_id || ''), String(run.department_id || ''),
        // The question IS the title. Inventing a summary here would put words on
        // a compliance record that no one wrote.
        prompt.slice(0, 300),
        description,
        severity,
        /* OWNER STARTS EMPTY, ON PURPOSE. There is no rule in this app that says
         * who mends a fridge, and guessing one — the department head, the person
         * who found it — would put a name on a job they never accepted. The queue
         * shows an unassigned action as needing an owner, and until one is set
         * anybody who can see it may record the fix (fssaiCaCompleteRefusal). */
        fssaiCaDueDate(severity, businessDate || fssaiToday()),
        actor.email || '',
        outletId,
      );

      /* created_task_id is left '' and nothing here writes it. The P1 spine says
       * the fix eventually becomes a row in the EXISTING Task Manager rather than
       * a second to-do list; that link is not built, and an empty column is an
       * honest "not yet" where a fabricated task id would be a lie a screen would
       * then try to follow. */

      fssaiAuditBestEffort(db, {
        entity_table: 'fssai_corrective_actions', entity_id: id, action: 'create',
        after: {
          ca_number: caNumber, run_id: runId, response_id: String(r.id),
          question_id: String(q.id), severity, status: 'open', title: prompt.slice(0, 300),
        },
        reason: `Raised automatically: this answer failed and the question is set to raise a corrective action.`,
        actor, outlet_id: outletId,
      });

      raised.push({
        id, ca_number: caNumber, question_id: String(q.id), response_id: String(r.id),
        title: prompt.slice(0, 300), severity,
        due_date: fssaiCaDueDate(severity, businessDate || fssaiToday()),
      });
    }
  } catch (e) {
    // See the contract above: the record is already true without this.
    console.error('raiseFssaiCorrectiveActions failed (the record stands):', e);
  }
  return raised;
}

/** One corrective action, shaped the single way every screen reads it. */
export function shapeFssaiCa(row: any) {
  return {
    id: String(row.id),
    ca_number: String(row.ca_number || ''),
    source_kind: String(row.source_kind || 'run'),
    run_id: row.run_id ? String(row.run_id) : '',
    response_id: String(row.response_id || ''),
    question_id: String(row.question_id || ''),
    equipment_id: String(row.equipment_id || ''),
    department_id: String(row.department_id || ''),
    department_name: String(row.department_name || ''),
    title: String(row.title || ''),
    description: String(row.description || ''),
    root_cause: String(row.root_cause || ''),
    severity: String(row.severity || 'medium'),
    severity_label: fssaiCaSeverityMeta(row.severity).label,
    status: String(row.status || 'open'),
    status_label: fssaiCaStatusMeta(row.status).label,
    owner_email: String(row.owner_email || ''),
    due_date: String(row.due_date || ''),
    action_taken: String(row.action_taken || ''),
    completed_at: String(row.completed_at || ''),
    completed_by: String(row.completed_by || ''),
    verified_by: String(row.verified_by || ''),
    verified_at: String(row.verified_at || ''),
    verify_note: String(row.verify_note || ''),
    void_reason: String(row.void_reason || ''),
    voided_by: String(row.voided_by || ''),
    voided_at: String(row.voided_at || ''),
    created_by: String(row.created_by || ''),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || ''),
    is_overdue: fssaiCaIsOverdue(
      { status: row.status, due_date: row.due_date },
      fssaiToday(),
    ),
    /* THE RECORD IT HANGS OFF, carried on every row so a list can say what
     * failed without a second request — and so a reader can always get back to
     * the check itself, which is the whole point of the link. */
    run: row.run_id
      ? {
        id: String(row.run_id),
        business_date: String(row.run_business_date || ''),
        shift: String(row.run_shift || ''),
        target_label: String(row.run_target_label || ''),
        status: String(row.run_status || ''),
        outcome: String(row.run_outcome || ''),
        recorded_by: String(row.run_recorded_by || ''),
        recorded_name: String(row.run_recorded_name || ''),
        template_name: String(row.template_name || ''),
      }
      : null,
    /** The FROZEN answer that caused it, when the response row is still there. */
    answer: row.response_id
      ? {
        prompt: String(row.answer_prompt || ''),
        text: fssaiAnswerInWords({
          is_na: row.answer_is_na, value_bool: row.answer_value_bool,
          value_num: row.answer_value_num, value_text: row.answer_value_text,
        }),
        uom: String(row.answer_uom || ''),
        note: String(row.answer_note || ''),
      }
      : null,
  };
}

/** The SELECT every corrective-action read shares, so no two lists disagree. */
export const FSSAI_CA_SELECT = `
  SELECT c.*,
         d.name  AS department_name,
         r.business_date AS run_business_date, r.shift AS run_shift,
         r.target_label  AS run_target_label,  r.status AS run_status,
         r.outcome       AS run_outcome,
         r.recorded_by   AS run_recorded_by,   r.recorded_name AS run_recorded_name,
         t.name          AS template_name,
         resp.question_id AS question_id,
         resp.prompt_snapshot AS answer_prompt, resp.uom AS answer_uom,
         resp.note AS answer_note, resp.is_na AS answer_is_na,
         resp.value_bool AS answer_value_bool, resp.value_num AS answer_value_num,
         resp.value_text AS answer_value_text
    FROM fssai_corrective_actions c
    LEFT JOIN fssai_runs      r    ON r.id = c.run_id
    LEFT JOIN fssai_templates t    ON t.id = r.template_id
    LEFT JOIN departments     d    ON d.id = c.department_id
    LEFT JOIN fssai_responses resp ON resp.id = c.response_id`;

/** Every action hanging off one record, oldest first. */
export function readFssaiCorrectiveActions(db: Database.Database, runId: string) {
  const rows = db.prepare(
    `${FSSAI_CA_SELECT} WHERE c.run_id = ? ORDER BY c.created_at ASC, c.rowid ASC`,
  ).all(runId) as any[];
  return rows.map(shapeFssaiCa);
}

/* ------------------------------------------------------------------ *
 * Small shared bits
 * ------------------------------------------------------------------ */

export function db$(): Database.Database {
  return getDb();
}

/**
 * A bound value no email, department id or role id can ever equal.
 *
 * Used wherever a scoping query substitutes a MISSING attribute. Binding ''
 * instead would match every row whose column is blank — which is most of them
 * — and turn "this user has no department" into "this user sees everything".
 * RECON §5 row 12: an empty allowed set means SEES NOTHING, not NO FILTER.
 */
export const FSSAI_NO_MATCH = '\u0000-no-fssai-match';

/** '1'/'true'/1/true → 1, else 0, with an explicit default for undefined. */
export function toInt01(v: unknown, dflt: 0 | 1): 0 | 1 {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'string') return v === '0' || v.toLowerCase() === 'false' ? 0 : 1;
  return v ? 1 : 0;
}

export function str(v: unknown, dflt = ''): string {
  if (v === undefined || v === null) return dflt;
  return String(v).trim();
}

/**
 * SQLITE_CONSTRAINT → a sentence a restaurant manager can act on.
 *
 * MEASURED, and the reason both spellings are matched: better-sqlite3 reports
 * a unique violation by COLUMN LIST, not by index name —
 *   "UNIQUE constraint failed: fssai_templates.outlet_id, fssai_templates.code"
 * — even for a partial index. Matching only `uq_fssai_templates_code` (the
 * obvious spelling) silently fell through to the generic fallback, so a second
 * checklist using an existing code told the admin nothing about the code. The
 * index names are kept as well in case a future SQLite reports those instead.
 */
export function constraintMessage(e: any, fallback: string): string | null {
  const code = String(e?.code || '');
  if (!code.startsWith('SQLITE_CONSTRAINT')) return null;
  const m = String(e?.message || '');
  const hit = (index: string, column: string) => m.includes(index) || m.includes(column);
  if (hit('uq_fssai_templates_code', 'fssai_templates.code')) return 'Another checklist already uses that code.';
  if (hit('uq_fssai_sections_code', 'fssai_sections.code')) return 'Another section in this checklist already uses that code.';
  if (hit('uq_fssai_questions_code', 'fssai_questions.code')) return 'Another question in this checklist already uses that code.';
  if (hit('uq_fssai_equipment_name', 'fssai_equipment.name')) return 'A piece of equipment with that name already exists.';
  if (hit('uq_fssai_runs_open', 'fssai_runs.recorded_by')) {
    return 'This check is already open. Reopen it from your list rather than starting a second one.';
  }
  if (hit('uq_fssai_responses_run_q', 'fssai_responses.question_id')) return 'That answer was already recorded.';
  return fallback;
}
