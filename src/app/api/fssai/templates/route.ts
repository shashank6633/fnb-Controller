/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import {
  canAuthorFssai, isFssaiFrequency, isFssaiTargetKind, normalizeFssaiQuestion,
  templateEditBumpsVersion, FSSAI_MODULE_KEYS, FSSAI_FREQUENCIES, FSSAI_TARGET_KINDS,
} from '@/lib/fssai';
import {
  requireFssaiAdmin, loadFssaiTemplate, fssaiAudit, fssaiAppAudit,
  bumpFssaiTemplateVersion, str, toInt01, constraintMessage,
} from '@/lib/fssai-server';

/**
 * FSSAI CHECKLISTS — the library (/api/fssai/templates).
 *
 * This is the engine the owner's §24 asked for: "Do not hard-code all
 * regulatory checklist questions. Keep the checklist engine configurable so
 * management can update requirements whenever regulations or internal SOPs
 * change." A checklist is rows, not code.
 *
 * GET    /api/fssai/templates?q=&status=&module_key=&department_id=&include_archived=1
 *          → { templates: [{ ...tpl, section_count, question_count, run_count,
 *                            open_run_count, assignment_count }], can_author }
 *          ANY SIGNED-IN USER, but a non-admin sees only PUBLISHED, active
 *          checklists — a draft is the admin's working copy, not a thing staff
 *          should find and try to run.
 *
 * POST   /api/fssai/templates            ADMIN. Create, or { action:'duplicate' }.
 * PUT    /api/fssai/templates            ADMIN. Edit the header. Bumps the
 *                                        version only for a structural change
 *                                        (src/lib/fssai.ts §7).
 * DELETE /api/fssai/templates?id=[&purge=1]
 *                                        ADMIN. ARCHIVE — never a hard delete
 *                                        once anything has been recorded
 *                                        against it (owner §19). `purge=1` is
 *                                        allowed only while the checklist has
 *                                        never been run; a refused purge is
 *                                        itself recorded, as 'delete_blocked'.
 *
 * WHY EVERY HANDLER RE-CHECKS THE USER: proxy.ts guards pages, not APIs
 * (proxy.ts:181), and canAccessPage fails open four ways. The route's own
 * predicate is the only gate that holds (RECON §2.1, §10 R6).
 *
 * §7 Q1 (PROVISIONAL): outlet_id is stamped on every row and filtering is
 * deferred — two outlets exist and the owner has not ruled.
 * §7 Q8 (PROVISIONAL): responsible_role_id points at an EXISTING role. FSSAI
 * never creates one (HARD RULE 4 — production config is the owner's).
 */
export const dynamic = 'force-dynamic';

const MAX_PCT = 100;

/** Shared header validation for create and edit. Returns an error sentence or null. */
function validateHeader(db: any, h: {
  name: string; frequency: string; target_kind: string; module_key: string;
  department_id: string; responsible_role_id: string; pass_threshold_pct: number;
  allow_backdate_days: number; category: string; code: string;
}): string | null {
  if (!h.name) return 'Give the checklist a name.';
  if (h.name.length > 160) return 'Keep the checklist name under 160 characters.';
  if (h.code && !/^[A-Za-z0-9._-]{2,48}$/.test(h.code)) {
    return 'A code may only contain letters, numbers, dots, dashes and underscores (2-48 characters).';
  }
  if (!isFssaiFrequency(h.frequency)) {
    return `"${h.frequency}" is not a frequency this system knows. Choose one of: ${FSSAI_FREQUENCIES.map((f) => f.label).join(', ')}.`;
  }
  if (!isFssaiTargetKind(h.target_kind)) {
    return `"${h.target_kind}" is not something a check can be run against. Choose one of: ${FSSAI_TARGET_KINDS.map((t) => t.label).join(', ')}.`;
  }
  if (h.module_key && !FSSAI_MODULE_KEYS.includes(h.module_key)) {
    return `"${h.module_key}" is not one of the food-safety areas.`;
  }
  if (!Number.isFinite(h.pass_threshold_pct) || h.pass_threshold_pct < 0 || h.pass_threshold_pct > MAX_PCT) {
    return 'The pass mark must be a percentage between 0 and 100.';
  }
  if (!Number.isInteger(h.allow_backdate_days) || h.allow_backdate_days < 0 || h.allow_backdate_days > 30) {
    return 'Backdating must be a whole number of days between 0 and 30 (0 = not allowed).';
  }
  // Masters are READ ONLY (owner §21 / HARD RULE 4). We only check the id exists.
  if (h.department_id) {
    const d = db.prepare('SELECT id FROM departments WHERE id = ?').get(h.department_id);
    if (!d) return 'That department no longer exists. Pick it again from the list.';
  }
  if (h.responsible_role_id) {
    const r = db.prepare('SELECT id FROM roles WHERE id = ?').get(h.responsible_role_id);
    if (!r) return 'That role no longer exists. Pick it again from the list.';
  }
  if (h.category && h.category.length > 40) return 'Keep the category short.';
  return null;
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  try {
    const url = new URL(request.url);
    const q = str(url.searchParams.get('q')).toLowerCase();
    const status = str(url.searchParams.get('status'));
    const moduleKey = str(url.searchParams.get('module_key'));
    const departmentId = str(url.searchParams.get('department_id'));
    const includeArchived = url.searchParams.get('include_archived') === '1';
    const admin = canAuthorFssai(me);

    const db = getDb();
    const where: string[] = [];
    const args: any[] = [];

    if (!admin) {
      // A non-admin sees the published library only. Drafts are the admin's
      // working copy; archived checklists are history he has retired.
      where.push(`t.status = 'published'`);
      where.push('t.is_active = 1');
    } else {
      if (status) { where.push('t.status = ?'); args.push(status); }
      else if (!includeArchived) { where.push(`t.status <> 'archived'`); }
    }
    if (moduleKey) { where.push('t.module_key = ?'); args.push(moduleKey); }
    if (departmentId) { where.push('t.department_id = ?'); args.push(departmentId); }

    const sql =
      `SELECT t.*,
              (SELECT COUNT(*) FROM fssai_sections  s WHERE s.template_id = t.id AND s.is_active = 1) AS section_count,
              (SELECT COUNT(*) FROM fssai_questions qq WHERE qq.template_id = t.id AND qq.is_active = 1) AS question_count,
              (SELECT COUNT(*) FROM fssai_runs      r WHERE r.template_id = t.id) AS run_count,
              (SELECT COUNT(*) FROM fssai_runs      r WHERE r.template_id = t.id AND r.status = 'in_progress') AS open_run_count,
              (SELECT COUNT(*) FROM fssai_assignments a WHERE a.template_id = t.id AND a.is_active = 1) AS assignment_count,
              d.name AS department_name,
              ro.name AS responsible_role_name
         FROM fssai_templates t
         LEFT JOIN departments d  ON d.id  = t.department_id
         LEFT JOIN roles       ro ON ro.id = t.responsible_role_id` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY t.sort_order ASC, t.name ASC`;

    let templates = db.prepare(sql).all(...args) as any[];
    if (q) {
      templates = templates.filter((t) =>
        `${t.name} ${t.code} ${t.description} ${t.category} ${t.module_key} ${t.department_name || ''}`
          .toLowerCase().includes(q));
    }
    return Response.json({ templates, can_author: admin });
  } catch (e: any) {
    console.error('GET /api/fssai/templates failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the checklists' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const g = await requireFssaiAdmin();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { /* validated below */ }
  const action = str(body?.action);

  try {
    const db = getDb();
    const outletId = (await getCurrentOutletId()) || '';

    /* ── duplicate ─────────────────────────────────────────────────────────
     * How the owner builds his second cold-room checklist. A copy is always a
     * fresh DRAFT at version 1 with a BLANK code — the code is the stable seed
     * key and is UNIQUE per outlet, so copying it would throw. */
    if (action === 'duplicate') {
      const srcId = str(body?.template_id);
      const src = loadFssaiTemplate(db, srcId, { includeRetired: true });
      if (!src) return Response.json({ error: 'That checklist no longer exists.' }, { status: 404 });

      const newId = generateId();
      const run = db.transaction(() => {
        db.prepare(
          `INSERT INTO fssai_templates
             (id, code, name, description, category, module_key, frequency, department_id,
              responsible_role_id, target_kind, requires_signature, requires_verification,
              allow_backdate_days, pass_threshold_pct, version, status, is_active, is_seeded,
              sort_order, created_by, outlet_id)
           VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'draft', 1, 0, ?, ?, ?)`,
        ).run(
          newId, `${src.name} (copy)`, src.description, src.category, src.module_key, src.frequency,
          src.department_id, src.responsible_role_id, src.target_kind, src.requires_signature,
          src.requires_verification, src.allow_backdate_days, src.pass_threshold_pct,
          src.sort_order, me.email || '', outletId,
        );

        // Sections first, so the questions can be re-pointed at the new ids.
        const secMap = new Map<string, string>();
        const insSec = db.prepare(
          `INSERT INTO fssai_sections (id, template_id, code, title, description, sort_order, is_active)
           VALUES (?, ?, '', ?, ?, ?, ?)`,
        );
        for (const s of src.sections as any[]) {
          const sid = generateId();
          secMap.set(s.id, sid);
          insSec.run(sid, newId, s.title, s.description, s.sort_order, s.is_active);
        }
        const insQ = db.prepare(
          `INSERT INTO fssai_questions
             (id, template_id, section_id, code, qtype, prompt, help_text, uom, min_value, max_value,
              target_value, decimals, expected_value, options_json, fail_options_json, is_required,
              is_critical, allow_na, photo_rule, note_rule, raise_ca_on_fail, ca_severity, sort_order, is_active)
           VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const qq of src.questions as any[]) {
          insQ.run(
            generateId(), newId, qq.section_id ? (secMap.get(qq.section_id) || null) : null,
            qq.qtype, qq.prompt, qq.help_text, qq.uom, qq.min_value, qq.max_value, qq.target_value,
            qq.decimals, qq.expected_value, qq.options_json, qq.fail_options_json, qq.is_required,
            qq.is_critical, qq.allow_na, qq.photo_rule, qq.note_rule, qq.raise_ca_on_fail,
            qq.ca_severity, qq.sort_order, qq.is_active,
          );
        }
        fssaiAudit(db, {
          entity_table: 'fssai_templates', entity_id: newId, action: 'create',
          after: { name: `${src.name} (copy)`, copied_from: srcId },
          reason: 'Copied from an existing checklist',
          actor: { email: me.email, name: me.name }, outlet_id: outletId,
        });
        return loadFssaiTemplate(db, newId, { includeRetired: true });
      });

      const tpl = run();
      fssaiAppAudit(db, {
        event_type: 'fssai.template.duplicate', entity_type: 'fssai_templates', entity_id: newId,
        actor_email: me.email, after: { name: tpl?.name, source: srcId },
      });
      return Response.json({ template: tpl });
    }

    /* ── create ─────────────────────────────────────────────────────────── */
    const header = {
      name: str(body?.name),
      code: str(body?.code),
      description: str(body?.description),
      category: str(body?.category) || 'Compliance',
      module_key: str(body?.module_key),
      frequency: str(body?.frequency) || 'daily',
      department_id: str(body?.department_id),
      responsible_role_id: str(body?.responsible_role_id),
      target_kind: str(body?.target_kind) || 'none',
      requires_signature: toInt01(body?.requires_signature, 1),
      requires_verification: toInt01(body?.requires_verification, 1),
      allow_backdate_days: Number(body?.allow_backdate_days ?? 1),
      pass_threshold_pct: Number(body?.pass_threshold_pct ?? 100),
      sort_order: Number(body?.sort_order ?? 0) || 0,
    };
    const bad = validateHeader(db, header);
    if (bad) return Response.json({ error: bad }, { status: 400 });

    // Optional children in the same call — the builder screen creates a
    // checklist and its first questions in one go, and the P8 seeds will use
    // exactly this shape. Validated BEFORE the transaction opens (RECON §2.3).
    const rawSections: any[] = Array.isArray(body?.sections) ? body.sections : [];
    const rawQuestions: any[] = Array.isArray(body?.questions) ? body.questions : [];
    const normQuestions: any[] = [];
    for (let i = 0; i < rawQuestions.length; i++) {
      const v = normalizeFssaiQuestion(rawQuestions[i] || {});
      if (!v.ok) return Response.json({ error: `Question ${i + 1}: ${v.error}` }, { status: 400 });
      normQuestions.push({ ...v.value, _section_ref: str(rawQuestions[i]?.section_ref ?? rawQuestions[i]?.section_code) });
    }

    const id = generateId();
    const create = db.transaction(() => {
      db.prepare(
        `INSERT INTO fssai_templates
           (id, code, name, description, category, module_key, frequency, department_id,
            responsible_role_id, target_kind, requires_signature, requires_verification,
            allow_backdate_days, pass_threshold_pct, version, status, is_active, is_seeded,
            sort_order, created_by, outlet_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'draft', 1, 0, ?, ?, ?)`,
      ).run(
        id, header.code, header.name, header.description, header.category, header.module_key,
        header.frequency, header.department_id, header.responsible_role_id, header.target_kind,
        header.requires_signature, header.requires_verification, header.allow_backdate_days,
        header.pass_threshold_pct, header.sort_order, me.email || '', outletId,
      );

      const secByRef = new Map<string, string>();
      const insSec = db.prepare(
        `INSERT INTO fssai_sections (id, template_id, code, title, description, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      rawSections.forEach((s: any, i: number) => {
        const title = str(s?.title);
        if (!title) return;
        const sid = generateId();
        const code = str(s?.code);
        insSec.run(sid, id, code, title, str(s?.description), Number(s?.sort_order ?? i) || i);
        secByRef.set(code || title, sid);
      });

      const insQ = db.prepare(
        `INSERT INTO fssai_questions
           (id, template_id, section_id, code, qtype, prompt, help_text, uom, min_value, max_value,
            target_value, decimals, expected_value, options_json, fail_options_json, is_required,
            is_critical, allow_na, photo_rule, note_rule, raise_ca_on_fail, ca_severity, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      normQuestions.forEach((qv: any, i: number) => {
        insQ.run(
          generateId(), id, qv._section_ref ? (secByRef.get(qv._section_ref) || null) : null,
          qv.code, qv.qtype, qv.prompt, qv.help_text, qv.uom, qv.min_value, qv.max_value,
          qv.target_value, qv.decimals, qv.expected_value, JSON.stringify(qv.options),
          JSON.stringify(qv.fail_options), qv.is_required, qv.is_critical, qv.allow_na,
          qv.photo_rule, qv.note_rule, qv.raise_ca_on_fail, qv.ca_severity, i,
        );
      });

      fssaiAudit(db, {
        entity_table: 'fssai_templates', entity_id: id, action: 'create',
        after: { ...header, sections: rawSections.length, questions: normQuestions.length },
        actor: { email: me.email, name: me.name }, outlet_id: outletId,
      });
      return loadFssaiTemplate(db, id, { includeRetired: true });
    });

    const tpl = create();
    fssaiAppAudit(db, {
      event_type: 'fssai.template.create', entity_type: 'fssai_templates', entity_id: id,
      actor_email: me.email, after: { name: header.name },
    });
    return Response.json({ template: tpl });
  } catch (e: any) {
    const nice = constraintMessage(e, 'That checklist could not be saved.');
    if (nice) return Response.json({ error: nice }, { status: 409 });
    console.error('POST /api/fssai/templates failed:', e);
    return Response.json({ error: e?.message || 'Failed to save the checklist' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const g = await requireFssaiAdmin();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { /* validated below */ }
  const id = str(body?.id);
  if (!id) return Response.json({ error: 'Which checklist? No id was sent.' }, { status: 400 });

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM fssai_templates WHERE id = ?`).get(id) as any;
    if (!existing) return Response.json({ error: 'That checklist no longer exists.' }, { status: 404 });

    // Merge the incoming fields over the stored row, THEN validate the final
    // shape once — the HRMS idiom (api/hr/tests/route.ts:695). Editing one
    // field still re-checks the whole header.
    const next = {
      name: body?.name !== undefined ? str(body.name) : existing.name,
      code: body?.code !== undefined ? str(body.code) : existing.code,
      description: body?.description !== undefined ? str(body.description) : existing.description,
      category: body?.category !== undefined ? (str(body.category) || 'Compliance') : existing.category,
      module_key: body?.module_key !== undefined ? str(body.module_key) : existing.module_key,
      frequency: body?.frequency !== undefined ? str(body.frequency) : existing.frequency,
      department_id: body?.department_id !== undefined ? str(body.department_id) : existing.department_id,
      responsible_role_id: body?.responsible_role_id !== undefined ? str(body.responsible_role_id) : existing.responsible_role_id,
      target_kind: body?.target_kind !== undefined ? str(body.target_kind) : existing.target_kind,
      requires_signature: body?.requires_signature !== undefined ? toInt01(body.requires_signature, 1) : existing.requires_signature,
      requires_verification: body?.requires_verification !== undefined ? toInt01(body.requires_verification, 1) : existing.requires_verification,
      allow_backdate_days: body?.allow_backdate_days !== undefined ? Number(body.allow_backdate_days) : existing.allow_backdate_days,
      pass_threshold_pct: body?.pass_threshold_pct !== undefined ? Number(body.pass_threshold_pct) : existing.pass_threshold_pct,
      sort_order: body?.sort_order !== undefined ? (Number(body.sort_order) || 0) : existing.sort_order,
    };
    const bad = validateHeader(db, next);
    if (bad) return Response.json({ error: bad }, { status: 400 });

    // Which fields actually changed, and does that set change WHAT WAS ASKED
    // or HOW IT WAS JUDGED? (src/lib/fssai.ts §7 holds the list, so the API
    // and the builder screen cannot disagree about it.)
    const changed: string[] = [];
    for (const k of Object.keys(next) as (keyof typeof next)[]) {
      if (String(existing[k] ?? '') !== String(next[k] ?? '')) changed.push(k);
    }
    if (!changed.length) {
      return Response.json({ template: loadFssaiTemplate(db, id, { includeRetired: true }), version_bumped: false, changed: [] });
    }
    const bump = templateEditBumpsVersion(changed);

    const save = db.transaction(() => {
      db.prepare(
        `UPDATE fssai_templates
            SET code=?, name=?, description=?, category=?, module_key=?, frequency=?,
                department_id=?, responsible_role_id=?, target_kind=?, requires_signature=?,
                requires_verification=?, allow_backdate_days=?, pass_threshold_pct=?, sort_order=?,
                updated_at=datetime('now')
          WHERE id=?`,
      ).run(
        next.code, next.name, next.description, next.category, next.module_key, next.frequency,
        next.department_id, next.responsible_role_id, next.target_kind, next.requires_signature,
        next.requires_verification, next.allow_backdate_days, next.pass_threshold_pct,
        next.sort_order, id,
      );
      const newVersion = bump ? bumpFssaiTemplateVersion(db, id) : existing.version;
      fssaiAudit(db, {
        entity_table: 'fssai_templates', entity_id: id, action: 'update',
        field: changed.join(','),
        before: Object.fromEntries(changed.map((k) => [k, existing[k]])),
        after: Object.fromEntries(changed.map((k) => [k, (next as any)[k]])),
        reason: bump ? `Structural change — version ${existing.version} → ${newVersion}` : '',
        actor: { email: me.email, name: me.name }, outlet_id: existing.outlet_id,
      });
      return newVersion;
    });

    const version = save();
    fssaiAppAudit(db, {
      event_type: 'fssai.template.update', entity_type: 'fssai_templates', entity_id: id,
      actor_email: me.email, before: { version: existing.version }, after: { version },
      note: changed.join(','),
    });
    return Response.json({
      template: loadFssaiTemplate(db, id, { includeRetired: true }),
      version_bumped: bump,
      version,
      changed,
    });
  } catch (e: any) {
    const nice = constraintMessage(e, 'That change could not be saved.');
    if (nice) return Response.json({ error: nice }, { status: 409 });
    console.error('PUT /api/fssai/templates failed:', e);
    return Response.json({ error: e?.message || 'Failed to update the checklist' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const g = await requireFssaiAdmin();
  if ('resp' in g) return g.resp;
  const me = g.me;

  try {
    const url = new URL(request.url);
    let id = str(url.searchParams.get('id'));
    const purge = url.searchParams.get('purge') === '1';
    const reason = str(url.searchParams.get('reason'));
    if (!id) { try { id = str((await request.json())?.id); } catch { /* noop */ } }
    if (!id) return Response.json({ error: 'Which checklist? No id was sent.' }, { status: 400 });

    const db = getDb();
    const existing = db.prepare(`SELECT * FROM fssai_templates WHERE id = ?`).get(id) as any;
    if (!existing) return Response.json({ error: 'That checklist no longer exists.' }, { status: 404 });
    const runCount = (db.prepare(`SELECT COUNT(*) AS n FROM fssai_runs WHERE template_id = ?`).get(id) as any).n as number;

    /* ── purge: only while nothing has ever been recorded ────────────────── */
    if (purge) {
      if (runCount > 0) {
        // Owner §19 — a checklist with history is NEVER removed. The refusal
        // is itself a compliance event, which is why 'delete_blocked' is in
        // the audit vocabulary.
        db.prepare(
          `INSERT INTO fssai_audit_log (id, entity_table, entity_id, action, field, before_json, after_json, reason, actor_email, actor_name, outlet_id)
           VALUES (?, 'fssai_templates', ?, 'delete_blocked', '', ?, '', ?, ?, ?, ?)`,
        ).run(
          generateId(), id, JSON.stringify({ name: existing.name, run_count: runCount }),
          'Checklist has recorded runs — archived instead of deleted',
          me.email || '', me.name || '', existing.outlet_id || '',
        );
        return Response.json(
          {
            error: `"${existing.name}" has ${runCount} recorded check${runCount === 1 ? '' : 's'} against it, so it cannot be deleted. Archive it instead — the records stay readable and no new checks can be started.`,
            run_count: runCount,
          },
          { status: 409 },
        );
      }
      const wipe = db.transaction(() => {
        // fssai_assignments → fssai_templates has NO ON DELETE clause, so the
        // assignments must go first or SQLite refuses the delete.
        db.prepare(`DELETE FROM fssai_assignments WHERE template_id = ?`).run(id);
        // Sections and questions CASCADE.
        db.prepare(`DELETE FROM fssai_templates WHERE id = ?`).run(id);
        fssaiAudit(db, {
          entity_table: 'fssai_templates', entity_id: id, action: 'delete',
          before: { name: existing.name, status: existing.status, version: existing.version },
          reason: reason || 'Deleted while never used',
          actor: { email: me.email, name: me.name }, outlet_id: existing.outlet_id,
        });
      });
      wipe();
      fssaiAppAudit(db, {
        event_type: 'fssai.template.delete', entity_type: 'fssai_templates', entity_id: id,
        actor_email: me.email, before: { name: existing.name }, note: 'never run',
      });
      return Response.json({ ok: true, deleted: true });
    }

    /* ── archive (the normal path) ───────────────────────────────────────── */
    if (existing.status === 'archived' && !existing.is_active) {
      return Response.json({ error: 'That checklist is already archived.' }, { status: 409 });
    }
    const archive = db.transaction(() => {
      db.prepare(
        `UPDATE fssai_templates SET status='archived', is_active=0, updated_at=datetime('now') WHERE id=?`,
      ).run(id);
      // An archived checklist must stop appearing in anyone's "due" list, so
      // its live assignments are stood down with it. They are kept (is_active=0),
      // never deleted, so restoring the checklist shows what it used to owe.
      const stood = db.prepare(
        `UPDATE fssai_assignments SET is_active=0, updated_at=datetime('now') WHERE template_id=? AND is_active=1`,
      ).run(id);
      fssaiAudit(db, {
        entity_table: 'fssai_templates', entity_id: id, action: 'update', field: 'status',
        before: { status: existing.status, is_active: existing.is_active },
        after: { status: 'archived', is_active: 0, assignments_stood_down: stood.changes },
        reason: reason || 'Archived',
        actor: { email: me.email, name: me.name }, outlet_id: existing.outlet_id,
      });
      return stood.changes;
    });
    const stoodDown = archive();
    fssaiAppAudit(db, {
      event_type: 'fssai.template.archive', entity_type: 'fssai_templates', entity_id: id,
      actor_email: me.email, before: { status: existing.status }, after: { status: 'archived' },
    });
    return Response.json({ ok: true, archived: true, assignments_stood_down: stoodDown, run_count: runCount });
  } catch (e: any) {
    const nice = constraintMessage(e, 'That checklist could not be archived.');
    if (nice) return Response.json({ error: nice }, { status: 409 });
    console.error('DELETE /api/fssai/templates failed:', e);
    return Response.json({ error: e?.message || 'Failed to archive the checklist' }, { status: 500 });
  }
}
