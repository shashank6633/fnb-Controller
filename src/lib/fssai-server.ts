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
import type Database from 'better-sqlite3';
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, type SessionUser } from '@/lib/auth';
import { canAuthorFssai, qtypeMeta } from '@/lib/fssai';

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
 * Small shared bits
 * ------------------------------------------------------------------ */

export function db$(): Database.Database {
  return getDb();
}

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

/** SQLITE_CONSTRAINT → a sentence a restaurant manager can act on. */
export function constraintMessage(e: any, fallback: string): string | null {
  const code = String(e?.code || '');
  if (!code.startsWith('SQLITE_CONSTRAINT')) return null;
  const m = String(e?.message || '');
  if (m.includes('uq_fssai_templates_code')) return 'Another checklist already uses that code.';
  if (m.includes('uq_fssai_sections_code')) return 'Another section in this checklist already uses that code.';
  if (m.includes('uq_fssai_questions_code')) return 'Another question in this checklist already uses that code.';
  if (m.includes('uq_fssai_runs_open')) return 'This check is already open. Reopen it from your list rather than starting a second one.';
  if (m.includes('uq_fssai_responses_run_q')) return 'That answer was already recorded.';
  if (m.includes('FOREIGN KEY')) return fallback;
  return fallback;
}
