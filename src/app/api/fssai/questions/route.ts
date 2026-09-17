/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { normalizeFssaiQuestion } from '@/lib/fssai';
import {
  requireFssaiAdmin, loadFssaiTemplate, fssaiAudit, bumpFssaiTemplateVersion,
  parseJsonArray, shapeQuestion, str, toInt01, constraintMessage,
} from '@/lib/fssai-server';

/**
 * CHECKLIST QUESTIONS (/api/fssai/questions). ADMIN ONLY, every method.
 *
 * The eight types the owner named live here as ROWS, which is the whole point
 * of §24: "Keep the checklist engine configurable so management can update
 * requirements whenever regulations or internal SOPs change." Nothing about a
 * temperature range, a pass mark or an acceptable answer is written into the
 * software.
 *
 * POST   { template_id, section_id?, qtype, prompt, … }     → add (at the end)
 * PUT    { id, …any field }                                 → edit (merge, then
 *                                                             validate the FINAL
 *                                                             shape once)
 *        { action:'reorder', template_id, order:[id,…] }    → reorder
 *        { action:'move', id, section_id }                  → move between groups
 * DELETE ?id=   → HARD delete only while it has never been answered; otherwise
 *                 RETIRED (is_active=0), which is the lawful way to remove a
 *                 question that has answers.
 *
 * ── THE ONE PATTERN THIS ROUTE REFUSES TO COPY ───────────────────────────
 * api/tasks/templates/route.ts:245-256 replaces a template's children with
 *   DELETE FROM checklist_items WHERE template_id = ?
 * and re-inserts them with NEW ids. Under FSSAI that is catastrophic:
 * fssai_responses.question_id is a declared FK and PRAGMA foreign_keys is ON
 * (db.ts:108), so on a checklist with answers the DELETE throws and the admin
 * gets a 500 he cannot act on; on one without answers it silently renumbers
 * every id. So THIS route never bulk-deletes: it addresses one question at a
 * time, by id.
 *
 * EVERY MUTATION BUMPS THE TEMPLATE VERSION — creating, editing, reordering,
 * retiring or reactivating a question all change what staff are asked. The
 * run's frozen template_version then makes the change visible, and the frozen
 * response snapshots make it harmless.
 */
export const dynamic = 'force-dynamic';

/** The columns an edit may touch, in the order the UPDATE writes them. */
function questionRowFrom(v: any) {
  return {
    qtype: v.qtype,
    prompt: v.prompt,
    help_text: v.help_text,
    uom: v.uom,
    min_value: v.min_value,
    max_value: v.max_value,
    target_value: v.target_value,
    decimals: v.decimals,
    expected_value: v.expected_value,
    options_json: JSON.stringify(v.options),
    fail_options_json: JSON.stringify(v.fail_options),
    is_required: v.is_required,
    is_critical: v.is_critical,
    allow_na: v.allow_na,
    photo_rule: v.photo_rule,
    note_rule: v.note_rule,
    raise_ca_on_fail: v.raise_ca_on_fail,
    ca_severity: v.ca_severity,
    code: v.code,
  };
}

export async function POST(request: Request) {
  const g = await requireFssaiAdmin();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { /* validated below */ }

  const templateId = str(body?.template_id);
  if (!templateId) return Response.json({ error: 'Which checklist? No id was sent.' }, { status: 400 });

  // Validate BEFORE opening the transaction and return the 400 early
  // (RECON §2.3 — api/tasks/checklists/route.ts:105-130 is the model).
  const v = normalizeFssaiQuestion(body || {});
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });

  try {
    const db = getDb();
    const tpl = db.prepare(`SELECT * FROM fssai_templates WHERE id = ?`).get(templateId) as any;
    if (!tpl) return Response.json({ error: 'That checklist no longer exists.' }, { status: 404 });

    const sectionId = str(body?.section_id) || null;
    if (sectionId) {
      const sec = db.prepare(`SELECT id, template_id FROM fssai_sections WHERE id = ?`).get(sectionId) as any;
      if (!sec) return Response.json({ error: 'That section no longer exists.' }, { status: 404 });
      if (sec.template_id !== templateId) {
        return Response.json({ error: 'That section belongs to a different checklist.' }, { status: 400 });
      }
    }

    const id = generateId();
    const row = questionRowFrom(v.value);
    const create = db.transaction(() => {
      const nextOrder = body?.sort_order !== undefined
        ? (Number(body.sort_order) || 0)
        : ((db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM fssai_questions WHERE template_id = ?`)
            .get(templateId) as any).n as number);
      db.prepare(
        `INSERT INTO fssai_questions
           (id, template_id, section_id, code, qtype, prompt, help_text, uom, min_value, max_value,
            target_value, decimals, expected_value, options_json, fail_options_json, is_required,
            is_critical, allow_na, photo_rule, note_rule, raise_ca_on_fail, ca_severity, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, templateId, sectionId, row.code, row.qtype, row.prompt, row.help_text, row.uom,
        row.min_value, row.max_value, row.target_value, row.decimals, row.expected_value,
        row.options_json, row.fail_options_json, row.is_required, row.is_critical, row.allow_na,
        row.photo_rule, row.note_rule, row.raise_ca_on_fail, row.ca_severity, nextOrder,
      );
      const version = bumpFssaiTemplateVersion(db, templateId);
      fssaiAudit(db, {
        entity_table: 'fssai_questions', entity_id: id, action: 'create',
        after: { template_id: templateId, ...row, sort_order: nextOrder },
        reason: `Checklist version ${tpl.version} → ${version}`,
        actor: { email: me.email, name: me.name }, outlet_id: tpl.outlet_id,
      });
      return version;
    });
    const version = create();
    const created = db.prepare(`SELECT * FROM fssai_questions WHERE id = ?`).get(id) as any;
    return Response.json({
      question: shapeQuestion(created),
      template: loadFssaiTemplate(db, templateId, { includeRetired: true }),
      version,
    });
  } catch (e: any) {
    const nice = constraintMessage(e, 'That question could not be saved.');
    if (nice) return Response.json({ error: nice }, { status: 409 });
    console.error('POST /api/fssai/questions failed:', e);
    return Response.json({ error: e?.message || 'Failed to save the question' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const g = await requireFssaiAdmin();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { /* validated below */ }
  const action = str(body?.action);

  try {
    const db = getDb();

    /* ── reorder ─────────────────────────────────────────────────────────── */
    if (action === 'reorder') {
      const templateId = str(body?.template_id);
      const order: string[] = Array.isArray(body?.order) ? body.order.map((x: any) => String(x)) : [];
      if (!templateId) return Response.json({ error: 'Which checklist? No id was sent.' }, { status: 400 });
      if (!order.length) return Response.json({ error: 'No new order was sent.' }, { status: 400 });

      const tpl = db.prepare(`SELECT * FROM fssai_templates WHERE id = ?`).get(templateId) as any;
      if (!tpl) return Response.json({ error: 'That checklist no longer exists.' }, { status: 404 });
      const mine = new Set((db.prepare(`SELECT id FROM fssai_questions WHERE template_id = ?`).all(templateId) as any[]).map((r) => r.id));
      const stray = order.find((qid) => !mine.has(qid));
      if (stray) return Response.json({ error: 'That list of questions does not belong to this checklist.' }, { status: 400 });

      const reorder = db.transaction(() => {
        const upd = db.prepare(`UPDATE fssai_questions SET sort_order=?, updated_at=datetime('now') WHERE id=? AND template_id=?`);
        order.forEach((qid, i) => upd.run(i, qid, templateId));
        const version = bumpFssaiTemplateVersion(db, templateId);
        fssaiAudit(db, {
          entity_table: 'fssai_questions', entity_id: templateId, action: 'update', field: 'sort_order',
          after: { order }, reason: `Questions reordered — checklist version ${tpl.version} → ${version}`,
          actor: { email: me.email, name: me.name }, outlet_id: tpl.outlet_id,
        });
        return version;
      });
      const version = reorder();
      return Response.json({ template: loadFssaiTemplate(db, templateId, { includeRetired: true }), version });
    }

    const id = str(body?.id);
    if (!id) return Response.json({ error: 'Which question? No id was sent.' }, { status: 400 });
    const existing = db.prepare(`SELECT * FROM fssai_questions WHERE id = ?`).get(id) as any;
    if (!existing) return Response.json({ error: 'That question no longer exists.' }, { status: 404 });
    const tpl = db.prepare(`SELECT * FROM fssai_templates WHERE id = ?`).get(existing.template_id) as any;
    if (!tpl) return Response.json({ error: 'That checklist no longer exists.' }, { status: 404 });

    /* ── move to another section (or out of one) ──────────────────────────── */
    if (action === 'move') {
      const sectionId = str(body?.section_id) || null;
      if (sectionId) {
        const sec = db.prepare(`SELECT id, template_id FROM fssai_sections WHERE id = ?`).get(sectionId) as any;
        if (!sec) return Response.json({ error: 'That section no longer exists.' }, { status: 404 });
        if (sec.template_id !== existing.template_id) {
          return Response.json({ error: 'That section belongs to a different checklist.' }, { status: 400 });
        }
      }
      const move = db.transaction(() => {
        db.prepare(`UPDATE fssai_questions SET section_id=?, updated_at=datetime('now') WHERE id=?`).run(sectionId, id);
        const version = bumpFssaiTemplateVersion(db, existing.template_id);
        fssaiAudit(db, {
          entity_table: 'fssai_questions', entity_id: id, action: 'update', field: 'section_id',
          before: { section_id: existing.section_id }, after: { section_id: sectionId },
          reason: `Checklist version ${tpl.version} → ${version}`,
          actor: { email: me.email, name: me.name }, outlet_id: tpl.outlet_id,
        });
        return version;
      });
      const version = move();
      return Response.json({ template: loadFssaiTemplate(db, existing.template_id, { includeRetired: true }), version });
    }

    /* ── edit ─────────────────────────────────────────────────────────────
     * Merge the incoming fields over the stored row and validate the FINAL
     * shape once — the HRMS idiom (api/hr/tests/route.ts:695-697). Editing
     * only the options still re-checks that the fail answers are members of
     * the list; editing only the minimum still re-checks it against the
     * stored maximum. */
    const stored = {
      qtype: existing.qtype,
      prompt: existing.prompt,
      help_text: existing.help_text,
      uom: existing.uom,
      min_value: existing.min_value,
      max_value: existing.max_value,
      target_value: existing.target_value,
      decimals: existing.decimals,
      expected_value: existing.expected_value,
      options: parseJsonArray(existing.options_json),
      fail_options: parseJsonArray(existing.fail_options_json),
      is_required: existing.is_required,
      is_critical: existing.is_critical,
      allow_na: existing.allow_na,
      photo_rule: existing.photo_rule,
      note_rule: existing.note_rule,
      raise_ca_on_fail: existing.raise_ca_on_fail,
      ca_severity: existing.ca_severity,
      code: existing.code,
    };
    const v = normalizeFssaiQuestion(body || {}, stored as any);
    if (!v.ok) return Response.json({ error: v.error }, { status: 400 });

    const row = questionRowFrom(v.value);
    const isActive = body?.is_active !== undefined ? toInt01(body.is_active, 1) : existing.is_active;

    const changed: string[] = [];
    for (const [k, val] of Object.entries(row)) {
      if (String(existing[k] ?? '') !== String(val ?? '')) changed.push(k);
    }
    if (Number(existing.is_active) !== Number(isActive)) changed.push('is_active');
    if (!changed.length) {
      return Response.json({
        question: shapeQuestion(existing),
        template: loadFssaiTemplate(db, existing.template_id, { includeRetired: true }),
        version: tpl.version, changed: [],
      });
    }

    const save = db.transaction(() => {
      db.prepare(
        `UPDATE fssai_questions
            SET qtype=?, prompt=?, help_text=?, uom=?, min_value=?, max_value=?, target_value=?,
                decimals=?, expected_value=?, options_json=?, fail_options_json=?, is_required=?,
                is_critical=?, allow_na=?, photo_rule=?, note_rule=?, raise_ca_on_fail=?,
                ca_severity=?, code=?, is_active=?, updated_at=datetime('now')
          WHERE id=?`,
      ).run(
        row.qtype, row.prompt, row.help_text, row.uom, row.min_value, row.max_value, row.target_value,
        row.decimals, row.expected_value, row.options_json, row.fail_options_json, row.is_required,
        row.is_critical, row.allow_na, row.photo_rule, row.note_rule, row.raise_ca_on_fail,
        row.ca_severity, row.code, isActive, id,
      );
      const version = bumpFssaiTemplateVersion(db, existing.template_id);
      fssaiAudit(db, {
        entity_table: 'fssai_questions', entity_id: id, action: 'update', field: changed.join(','),
        before: Object.fromEntries(changed.map((k) => [k, existing[k]])),
        after: Object.fromEntries(changed.map((k) => [k, k === 'is_active' ? isActive : (row as any)[k]])),
        reason: `Checklist version ${tpl.version} → ${version}`,
        actor: { email: me.email, name: me.name }, outlet_id: tpl.outlet_id,
      });
      return version;
    });
    const version = save();
    const after = db.prepare(`SELECT * FROM fssai_questions WHERE id = ?`).get(id) as any;
    return Response.json({
      question: shapeQuestion(after),
      template: loadFssaiTemplate(db, existing.template_id, { includeRetired: true }),
      version, changed,
    });
  } catch (e: any) {
    const nice = constraintMessage(e, 'That question could not be saved.');
    if (nice) return Response.json({ error: nice }, { status: 409 });
    console.error('PUT /api/fssai/questions failed:', e);
    return Response.json({ error: e?.message || 'Failed to update the question' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const g = await requireFssaiAdmin();
  if ('resp' in g) return g.resp;
  const me = g.me;

  try {
    const url = new URL(request.url);
    let id = str(url.searchParams.get('id'));
    if (!id) { try { id = str((await request.json())?.id); } catch { /* noop */ } }
    if (!id) return Response.json({ error: 'Which question? No id was sent.' }, { status: 400 });

    const db = getDb();
    const existing = db.prepare(`SELECT * FROM fssai_questions WHERE id = ?`).get(id) as any;
    if (!existing) return Response.json({ error: 'That question no longer exists.' }, { status: 404 });
    const tpl = db.prepare(`SELECT * FROM fssai_templates WHERE id = ?`).get(existing.template_id) as any;
    if (!tpl) return Response.json({ error: 'That checklist no longer exists.' }, { status: 404 });

    const answers = (db.prepare(
      `SELECT COUNT(*) AS n FROM fssai_responses WHERE question_id = ?`,
    ).get(id) as any).n as number;

    /* ── answered: RETIRE, never delete ───────────────────────────────────
     * fssai_responses.question_id is a declared FK, so a hard delete would
     * throw — but the real reason is owner §19: a question somebody has
     * already answered is part of a record. is_active=0 takes it off every
     * future run and leaves every past one intact. */
    if (answers > 0) {
      if (!Number(existing.is_active)) {
        return Response.json({ error: 'That question is already switched off.' }, { status: 409 });
      }
      const retire = db.transaction(() => {
        db.prepare(`UPDATE fssai_questions SET is_active=0, updated_at=datetime('now') WHERE id=?`).run(id);
        const version = bumpFssaiTemplateVersion(db, existing.template_id);
        fssaiAudit(db, {
          entity_table: 'fssai_questions', entity_id: id, action: 'update', field: 'is_active',
          before: { is_active: 1, prompt: existing.prompt },
          after: { is_active: 0, answered_before: answers },
          reason: `Question has ${answers} recorded answer${answers === 1 ? '' : 's'} — retired, not deleted (owner §19). Checklist version ${tpl.version} → ${version}`,
          actor: { email: me.email, name: me.name }, outlet_id: tpl.outlet_id,
        });
        return version;
      });
      const version = retire();
      return Response.json({
        ok: true, retired: true, answered_count: answers,
        message: `"${existing.prompt}" has already been answered ${answers} time${answers === 1 ? '' : 's'}, so it was switched off rather than deleted. Those records still show it exactly as it was asked.`,
        template: loadFssaiTemplate(db, existing.template_id, { includeRetired: true }),
        version,
      });
    }

    /* ── never answered: a genuine delete ─────────────────────────────────── */
    const wipe = db.transaction(() => {
      db.prepare(`DELETE FROM fssai_questions WHERE id = ?`).run(id);
      const version = bumpFssaiTemplateVersion(db, existing.template_id);
      fssaiAudit(db, {
        entity_table: 'fssai_questions', entity_id: id, action: 'delete',
        before: { prompt: existing.prompt, qtype: existing.qtype, template_id: existing.template_id },
        reason: `Never answered — checklist version ${tpl.version} → ${version}`,
        actor: { email: me.email, name: me.name }, outlet_id: tpl.outlet_id,
      });
      return version;
    });
    const version = wipe();
    return Response.json({
      ok: true, deleted: true,
      template: loadFssaiTemplate(db, existing.template_id, { includeRetired: true }),
      version,
    });
  } catch (e: any) {
    const nice = constraintMessage(e, 'That question could not be removed.');
    if (nice) return Response.json({ error: nice }, { status: 409 });
    console.error('DELETE /api/fssai/questions failed:', e);
    return Response.json({ error: e?.message || 'Failed to remove the question' }, { status: 500 });
  }
}
