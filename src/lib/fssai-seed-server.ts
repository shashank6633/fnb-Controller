/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * APPLYING THE READY-MADE CHECKLIST PACK (P8) — the server half.
 *
 * ⚠️ WHY THIS IS NOT A BOOT SEED, which is the one decision P8 had to get right.
 *
 * `scripts/check-boot-migrations.js` states the rule in its own words
 * (check-boot-migrations.js:8-23): *"The migration block in src/lib/db.ts runs on
 * EVERY getDb() cold start, and a deploy restarts the process — so 'runs on boot'
 * means 'runs on every deploy'. That is fine for a schema change … It is NOT fine
 * for anything a human has decided."* The twelve checklists are exactly that: the
 * owner is meant to edit them, reorder them and RETIRE the ones he does not want
 * (owner §24). A boot seed keyed on `code` with INSERT OR IGNORE cannot tell
 * "never seeded" from "seeded and then deliberately thrown out" — both look like
 * an absent row — so the next restart brings back everything he removed. The
 * live `menu_categories` lock exists for the identical shape.
 *
 * So the pack is applied ONCE, BY AN ADMINISTRATOR, THROUGH A ROUTE HE CALLS:
 *   · nothing happens on boot, on deploy or on a cold start;
 *   · the marker row in `fssai_seed_log` is written FIRST, inside the same
 *     transaction, and `uq_fssai_seed_item` makes a second apply impossible —
 *     a UNIQUE failure on that insert IS the "already ran" answer;
 *   · a checklist code that already exists is SKIPPED and logged, never
 *     overwritten: by the time anyone presses this twice, the row may carry the
 *     owner's own edits and a seed has no business replacing them.
 *
 * ALL OR NOTHING. One `db.transaction`, so a half-seeded library cannot exist —
 * which matters because RECON §10 R1 warns that *"a half-migrated template looks
 * exactly like a correct one"*. If anything throws, the marker row rolls back
 * with it and the admin can fix the cause and press again.
 *
 * better-sqlite3 is SYNCHRONOUS (HARD RULE 6). Nothing in this file is awaited
 * inside a transaction, and nothing in it is async at all.
 */

import type Database from 'better-sqlite3';
import { generateId } from './db';
import { fssaiConfigWarnings } from './fssai';
import { fssaiAudit, fssaiAppAudit } from './fssai-server';
import {
  FSSAI_CHECKLIST_PACK,
  validateFssaiChecklistPack,
  type ChecklistPack,
  type PackProblem,
  type PackTemplate,
} from './fssai-checklist-pack';

/* ------------------------------------------------------------------ *
 * What the screen reads
 * ------------------------------------------------------------------ */

export interface SeedTemplateState {
  code: string;
  name: string;
  module_key: string;
  frequency: string;
  target_kind: string;
  section_count: number;
  question_count: number;
  critical_count: number;
  /** Set when a checklist with this code already exists in this outlet. */
  existing: null | {
    id: string;
    name: string;
    status: string;
    version: number;
    is_active: number;
    is_seeded: number;
    question_count: number;
    run_count: number;
  };
  /** fssaiConfigWarnings for the template as the pack would create it. */
  warnings: string[];
}

export interface SeedLogRow {
  item_kind: string;
  item_code: string;
  item_id: string;
  action: string;
  detail: string;
  applied_by: string;
  created_at: string;
}

export interface SeedState {
  pack_key: string;
  pack_version: number;
  pack_title: string;
  /** True once the marker row exists — the pack can never run again. */
  applied: boolean;
  applied_at: string;
  applied_by: string;
  counts: { templates: number; sections: number; questions: number };
  /** Empty unless this build's engine cannot render something in the pack. */
  problems: PackProblem[];
  templates: SeedTemplateState[];
  log: SeedLogRow[];
}

function packMarker(db: Database.Database, pack: ChecklistPack): any {
  return db.prepare(
    `SELECT * FROM fssai_seed_log
      WHERE pack_key = ? AND pack_version = ? AND item_kind = 'pack'
      ORDER BY created_at ASC LIMIT 1`,
  ).get(pack.key, pack.version);
}

/**
 * Everything the admin screen shows, and everything the apply route checks
 * before it writes. Read-only.
 *
 * `outletId` scopes the "does this code already exist" lookup, because
 * `uq_fssai_templates_code` is UNIQUE on (outlet_id, code) — a code taken in
 * another outlet does not collide.
 */
export function readFssaiChecklistSeedState(
  db: Database.Database,
  outletId: string,
  pack: ChecklistPack = FSSAI_CHECKLIST_PACK,
): SeedState {
  const validation = validateFssaiChecklistPack(pack);
  const marker = packMarker(db, pack);

  const findTemplate = db.prepare(
    `SELECT t.id, t.name, t.status, t.version, t.is_active, t.is_seeded,
            (SELECT COUNT(*) FROM fssai_questions q WHERE q.template_id = t.id AND q.is_active = 1) AS question_count,
            (SELECT COUNT(*) FROM fssai_runs r WHERE r.template_id = t.id) AS run_count
       FROM fssai_templates t
      WHERE t.code = ? AND t.outlet_id = ?`,
  );

  const templates: SeedTemplateState[] = pack.templates.map((t) => {
    const row = findTemplate.get(t.code, outletId) as any;
    return {
      code: t.code,
      name: t.name,
      module_key: t.module_key,
      frequency: t.frequency,
      target_kind: t.target_kind,
      section_count: t.sections.length,
      question_count: t.questions.length,
      critical_count: t.questions.filter((q) => Number(q.is_critical) === 1).length,
      existing: row
        ? {
            id: String(row.id),
            name: String(row.name),
            status: String(row.status),
            version: Number(row.version),
            is_active: Number(row.is_active),
            is_seeded: Number(row.is_seeded),
            question_count: Number(row.question_count),
            run_count: Number(row.run_count),
          }
        : null,
      // The pack never sets a department, so the warning about a
      // restaurant-wide checklist is the honest one to show. The apply route
      // recomputes it with whatever department the admin actually chose.
      warnings: fssaiConfigWarnings({
        target_kind: t.target_kind,
        frequency: t.frequency,
        department_id: '',
        requires_verification: t.requires_verification ?? 1,
      }),
    };
  });

  const log = db.prepare(
    `SELECT item_kind, item_code, item_id, action, detail, applied_by, created_at
       FROM fssai_seed_log WHERE pack_key = ? AND pack_version = ?
      ORDER BY created_at ASC, rowid ASC`,
  ).all(pack.key, pack.version) as SeedLogRow[];

  return {
    pack_key: pack.key,
    pack_version: pack.version,
    pack_title: pack.title,
    applied: !!marker,
    applied_at: marker ? String(marker.created_at || '') : '',
    applied_by: marker ? String(marker.applied_by || '') : '',
    counts: validation.counts,
    problems: validation.problems,
    templates,
    log,
  };
}

/* ------------------------------------------------------------------ *
 * Applying it
 * ------------------------------------------------------------------ */

export interface ApplyOptions {
  /** users.email of the administrator pressing the button. */
  actor: { email?: string | null; name?: string | null };
  outletId: string;
  /**
   * Optional department per template code, chosen by the admin and ALREADY
   * validated to exist. Departments are the owner's (HARD RULE 4) — this only
   * ever reads an id he already created, and a missing entry means
   * restaurant-wide.
   */
  departmentByCode?: Record<string, string>;
  /**
   * Seed the twelve as PUBLISHED rather than as drafts.
   *
   * The default is `false` and that is the deliberate, reversible choice: a
   * draft is invisible to staff (templates/route.ts shows a non-admin only
   * published, active checklists), so the owner reads each one, changes what he
   * wants and publishes it himself. Publishing is one click per checklist;
   * un-publishing twelve checklists staff have already filed in is not.
   */
  publish?: boolean;
  pack?: ChecklistPack;
}

export interface ApplyItemResult {
  code: string;
  name: string;
  action: 'inserted' | 'skipped';
  template_id: string;
  sections: number;
  questions: number;
  detail: string;
  warnings: string[];
}

export type ApplyResult =
  | { ok: false; code: 'already_applied'; message: string; state: SeedState }
  | { ok: false; code: 'pack_invalid'; message: string; problems: PackProblem[] }
  | { ok: false; code: 'unknown_department'; message: string }
  | { ok: true; inserted: number; skipped: number; items: ApplyItemResult[]; status: string };

/** Does the error name our marker's uniqueness rule? */
function isPackAlreadyRan(e: any): boolean {
  const m = String(e?.message || '');
  return /UNIQUE constraint failed/i.test(m) && /fssai_seed_log/i.test(m);
}

/**
 * Create the twelve checklists, once.
 *
 * Returns a tagged result rather than throwing, so the route can answer the
 * three refusals in the owner's own words (already applied · the engine cannot
 * render something in the pack · a department that no longer exists).
 */
export function applyFssaiChecklistPack(db: Database.Database, opts: ApplyOptions): ApplyResult {
  const pack = opts.pack || FSSAI_CHECKLIST_PACK;
  const outletId = opts.outletId || '';
  const actorEmail = String(opts.actor?.email || '');
  const deptByCode = opts.departmentByCode || {};
  const publish = !!opts.publish;

  /* 1. THE ENGINE'S OWN RULES, BEFORE A TRANSACTION IS OPENED (RECON §2.3 and
   *    §10 R1). A pack this build cannot render must never reach the database. */
  const validation = validateFssaiChecklistPack(pack);
  if (!validation.ok) {
    return {
      ok: false,
      code: 'pack_invalid',
      message:
        `${validation.problems.length} thing${validation.problems.length === 1 ? '' : 's'} in the ready-made checklists ` +
        `cannot be set up by this version of the checklist builder. Nothing was created.`,
      problems: validation.problems,
    };
  }

  /* 2. Already applied? Answered here for a clear message, and again by the
   *    UNIQUE index inside the transaction — which is the answer that actually
   *    holds against two administrators pressing at the same moment. */
  if (packMarker(db, pack)) {
    const state = readFssaiChecklistSeedState(db, outletId, pack);
    return {
      ok: false,
      code: 'already_applied',
      message:
        `The ready-made checklists were already set up${state.applied_at ? ` on ${state.applied_at}` : ''}` +
        `${state.applied_by ? ` by ${state.applied_by}` : ''}. They are not added a second time — ` +
        `that would bring back any checklist you have since retired.`,
      state,
    };
  }

  /* 3. Departments are READ ONLY (HARD RULE 4). Match on id, never on name:
   *    live names carry double spaces ("Akan  Indian") — RECON §5 row 5. */
  const resolvedDept = new Map<string, string>();
  const deptStmt = db.prepare('SELECT id FROM departments WHERE id = ?');
  for (const t of pack.templates) {
    const want = String(deptByCode[t.code] || '').trim();
    if (!want) continue;
    if (!deptStmt.get(want)) {
      return {
        ok: false,
        code: 'unknown_department',
        message: `The department chosen for "${t.name}" no longer exists. Pick it again from the list.`,
      };
    }
    resolvedDept.set(t.code, want);
  }

  const nowStatus = publish ? 'published' : 'draft';
  const items: ApplyItemResult[] = [];

  const insTemplate = db.prepare(
    `INSERT INTO fssai_templates
       (id, code, name, description, category, module_key, frequency, department_id,
        responsible_role_id, target_kind, requires_signature, requires_verification,
        allow_backdate_days, pass_threshold_pct, version, status, is_active, is_seeded,
        sort_order, published_by, published_at, created_by, outlet_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, 1, ?, 1, 1, ?, ?, ?, ?, ?)`,
  );
  const insSection = db.prepare(
    `INSERT INTO fssai_sections (id, template_id, code, title, description, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insQuestion = db.prepare(
    `INSERT INTO fssai_questions
       (id, template_id, section_id, code, qtype, prompt, help_text, uom, min_value, max_value,
        target_value, decimals, expected_value, options_json, fail_options_json, is_required,
        is_critical, allow_na, photo_rule, note_rule, raise_ca_on_fail, ca_severity, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insLog = db.prepare(
    `INSERT INTO fssai_seed_log
       (id, pack_key, pack_version, item_kind, item_code, item_id, action, detail, applied_by, outlet_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const findByCode = db.prepare('SELECT id, name, status FROM fssai_templates WHERE code = ? AND outlet_id = ?');

  const run = db.transaction(() => {
    /* THE MARKER GOES IN FIRST. uq_fssai_seed_item is UNIQUE on
     * (pack_key, pack_version, item_kind, item_code), so a UNIQUE failure here
     * means another apply already won — including one racing us in another
     * request — and the whole transaction unwinds. This is the gate; the read
     * above is only the friendly message. */
    insLog.run(
      generateId(), pack.key, pack.version, 'pack', '', '', 'inserted',
      `${pack.title} — ${validation.counts.templates} checklists, ${validation.counts.sections} sections, ` +
      `${validation.counts.questions} questions, created as ${nowStatus}`,
      actorEmail || 'unknown', outletId,
    );

    for (const vt of validation.templates) {
      const t: PackTemplate = vt.template;
      const already = findByCode.get(t.code, outletId) as any;
      if (already) {
        /* NEVER OVERWRITE. The row may be the owner's own edit of this very
         * checklist, or a different checklist that happens to use the code. A
         * seed that replaced it would silently undo his work. */
        insLog.run(
          generateId(), pack.key, pack.version, 'template', t.code, String(already.id), 'skipped',
          `A checklist with this code already exists ("${already.name}", ${already.status}) — left exactly as it is.`,
          actorEmail || 'unknown', outletId,
        );
        items.push({
          code: t.code, name: t.name, action: 'skipped', template_id: String(already.id),
          sections: 0, questions: 0,
          detail: `Already there as "${already.name}" (${already.status}). Nothing was changed.`,
          warnings: [],
        });
        continue;
      }

      const templateId = generateId();
      const departmentId = resolvedDept.get(t.code) || '';
      insTemplate.run(
        templateId, t.code, t.name, t.description, t.category || 'Compliance', t.module_key,
        t.frequency, departmentId, t.target_kind,
        t.requires_signature === undefined ? 1 : t.requires_signature,
        t.requires_verification === undefined ? 1 : t.requires_verification,
        t.allow_backdate_days === undefined ? 1 : t.allow_backdate_days,
        t.pass_threshold_pct === undefined ? 100 : t.pass_threshold_pct,
        nowStatus, t.sort_order,
        publish ? actorEmail : '', publish ? new Date().toISOString() : '',
        actorEmail, outletId,
      );

      const sectionIdByCode = new Map<string, string>();
      t.sections.forEach((s, i) => {
        const sid = generateId();
        sectionIdByCode.set(s.code, sid);
        insSection.run(sid, templateId, s.code, s.title, s.description || '', i * 10);
      });

      vt.questions.forEach((vq, i) => {
        const q = vq.value;
        insQuestion.run(
          generateId(), templateId,
          // NULL, never '' — foreign_keys=ON makes '' throw on the section FK.
          vq.section ? (sectionIdByCode.get(vq.section) || null) : null,
          vq.code, q.qtype, q.prompt, q.help_text, q.uom,
          q.min_value, q.max_value, q.target_value, q.decimals, q.expected_value,
          JSON.stringify(q.options), JSON.stringify(q.fail_options),
          q.is_required, q.is_critical, q.allow_na, q.photo_rule, q.note_rule,
          q.raise_ca_on_fail, q.ca_severity, i * 10,
        );
      });

      /* ONE LOG ROW PER CHECKLIST, not one per question.
       * The DDL's reason for per-item rows is that a swallowed error would
       * otherwise leave no trace — but this whole apply is ONE transaction, so a
       * question that will not insert takes the entire pack down with it and
       * there is nothing to half-record. The counts below are what somebody
       * reading the log a year from now actually needs, and the questions
       * themselves are in fssai_questions, joinable on `code`. */
      insLog.run(
        generateId(), pack.key, pack.version, 'template', t.code, templateId, 'inserted',
        `${t.sections.length} sections, ${vt.questions.length} questions, ${nowStatus}` +
        (departmentId ? `, department ${departmentId}` : ', whole restaurant'),
        actorEmail || 'unknown', outletId,
      );

      fssaiAudit(db, {
        entity_table: 'fssai_templates', entity_id: templateId, action: 'create',
        after: { code: t.code, name: t.name, module_key: t.module_key, status: nowStatus, is_seeded: 1 },
        reason: `Set up from the ready-made checklists (${pack.key} v${pack.version})`,
        actor: { email: opts.actor?.email || '', name: opts.actor?.name || '' },
        outlet_id: outletId,
      });

      items.push({
        code: t.code, name: t.name, action: 'inserted', template_id: templateId,
        sections: t.sections.length, questions: vt.questions.length,
        detail: `Created as a ${nowStatus} with ${vt.questions.length} questions.`,
        warnings: fssaiConfigWarnings({
          target_kind: t.target_kind,
          frequency: t.frequency,
          department_id: departmentId,
          requires_verification: t.requires_verification ?? 1,
        }),
      });
    }
  });

  try {
    run();
  } catch (e: any) {
    if (isPackAlreadyRan(e)) {
      const state = readFssaiChecklistSeedState(db, outletId, pack);
      return {
        ok: false,
        code: 'already_applied',
        message:
          'The ready-made checklists were set up a moment ago by somebody else. Nothing was added twice.',
        state,
      };
    }
    throw e;
  }

  const inserted = items.filter((i) => i.action === 'inserted').length;
  const skipped = items.length - inserted;

  // The app-wide trail too, outside the transaction: logAuditEvent never
  // throws, so it is not allowed to influence whether the seed stands.
  fssaiAppAudit(db, {
    event_type: 'fssai.checklist_pack.apply',
    entity_type: 'fssai_seed_log',
    entity_id: pack.key,
    actor_email: actorEmail,
    after: { pack_key: pack.key, pack_version: pack.version, inserted, skipped, status: nowStatus },
    note: `${inserted} ready-made checklists created, ${skipped} left alone`,
  });

  return { ok: true, inserted, skipped, items, status: nowStatus };
}
