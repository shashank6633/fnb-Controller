/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import {
  requireFssaiAdmin, loadFssaiTemplate, fssaiAudit, bumpFssaiTemplateVersion,
  str, toInt01, constraintMessage,
} from '@/lib/fssai-server';

/**
 * CHECKLIST SECTIONS — the ordered groups inside one checklist
 * (/api/fssai/sections). ADMIN ONLY, every method (owner §20).
 *
 * POST   { template_id, title, code?, description?, sort_order? }  → create
 * PUT    { id, title?, code?, description?, is_active? }           → rename / retire
 *        { action:'reorder', template_id, order:[id,…] }           → reorder
 * DELETE ?id=            → remove, but ONLY while no live question sits in it
 *
 * WHY A SECTION CAN BE DELETED OUTRIGHT AND A QUESTION CANNOT: nothing in the
 * record refers to a section. fssai_responses freezes the question's prompt,
 * type, unit and thresholds, and has no section column at all — so removing an
 * empty group rewrites no history. A question WITH answers is the opposite
 * case and is retired, never deleted (see /api/fssai/questions).
 *
 * EVERY MUTATION HERE BUMPS THE TEMPLATE VERSION. Adding, renaming, reordering
 * or retiring a group changes the paper staff are handed, and the version is
 * what makes that change visible against runs already recorded
 * (fssai_runs.template_version). The HRMS precedent is three identical
 * `UPDATE hr_tests SET version = version + 1` calls, always inside the same
 * transaction as the mutation (api/hr/tests/route.ts:316, :677, :825).
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const g = await requireFssaiAdmin();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { /* validated below */ }

  const templateId = str(body?.template_id);
  const title = str(body?.title);
  const code = str(body?.code);
  if (!templateId) return Response.json({ error: 'Which checklist? No id was sent.' }, { status: 400 });
  if (!title) return Response.json({ error: 'Give the section a heading.' }, { status: 400 });
  if (title.length > 160) return Response.json({ error: 'Keep the section heading under 160 characters.' }, { status: 400 });
  if (code && !/^[A-Za-z0-9._-]{2,48}$/.test(code)) {
    return Response.json({ error: 'A code may only contain letters, numbers, dots, dashes and underscores (2-48 characters).' }, { status: 400 });
  }

  try {
    const db = getDb();
    const tpl = db.prepare(`SELECT * FROM fssai_templates WHERE id = ?`).get(templateId) as any;
    if (!tpl) return Response.json({ error: 'That checklist no longer exists.' }, { status: 404 });

    const id = generateId();
    const create = db.transaction(() => {
      const nextOrder = body?.sort_order !== undefined
        ? (Number(body.sort_order) || 0)
        : ((db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM fssai_sections WHERE template_id = ?`)
            .get(templateId) as any).n as number);
      db.prepare(
        `INSERT INTO fssai_sections (id, template_id, code, title, description, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, templateId, code, title, str(body?.description), nextOrder);
      const version = bumpFssaiTemplateVersion(db, templateId);
      fssaiAudit(db, {
        entity_table: 'fssai_sections', entity_id: id, action: 'create',
        after: { template_id: templateId, title, code, sort_order: nextOrder },
        reason: `Checklist version ${tpl.version} → ${version}`,
        actor: { email: me.email, name: me.name }, outlet_id: tpl.outlet_id,
      });
      return version;
    });
    const version = create();
    return Response.json({ template: loadFssaiTemplate(db, templateId, { includeRetired: true }), version, section_id: id });
  } catch (e: any) {
    const nice = constraintMessage(e, 'That section could not be saved.');
    if (nice) return Response.json({ error: nice }, { status: 409 });
    console.error('POST /api/fssai/sections failed:', e);
    return Response.json({ error: e?.message || 'Failed to save the section' }, { status: 500 });
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

    /* ── reorder ──────────────────────────────────────────────────────────
     * The whole order arrives as a list of ids, so a move is one atomic
     * rewrite rather than a pair of swaps that can half-apply. Any id not
     * belonging to this checklist is refused outright — a reorder must never
     * be able to reach into another checklist's rows. */
    if (action === 'reorder') {
      const templateId = str(body?.template_id);
      const order: string[] = Array.isArray(body?.order) ? body.order.map((x: any) => String(x)) : [];
      if (!templateId) return Response.json({ error: 'Which checklist? No id was sent.' }, { status: 400 });
      if (!order.length) return Response.json({ error: 'No new order was sent.' }, { status: 400 });

      const tpl = db.prepare(`SELECT * FROM fssai_templates WHERE id = ?`).get(templateId) as any;
      if (!tpl) return Response.json({ error: 'That checklist no longer exists.' }, { status: 404 });
      const mine = new Set((db.prepare(`SELECT id FROM fssai_sections WHERE template_id = ?`).all(templateId) as any[]).map((r) => r.id));
      const stray = order.find((sid) => !mine.has(sid));
      if (stray) return Response.json({ error: 'That list of sections does not belong to this checklist.' }, { status: 400 });

      const reorder = db.transaction(() => {
        const upd = db.prepare(`UPDATE fssai_sections SET sort_order=?, updated_at=datetime('now') WHERE id=? AND template_id=?`);
        order.forEach((sid, i) => upd.run(i, sid, templateId));
        const version = bumpFssaiTemplateVersion(db, templateId);
        fssaiAudit(db, {
          entity_table: 'fssai_sections', entity_id: templateId, action: 'update', field: 'sort_order',
          after: { order }, reason: `Sections reordered — checklist version ${tpl.version} → ${version}`,
          actor: { email: me.email, name: me.name }, outlet_id: tpl.outlet_id,
        });
        return version;
      });
      const version = reorder();
      return Response.json({ template: loadFssaiTemplate(db, templateId, { includeRetired: true }), version });
    }

    /* ── rename / retire / reactivate ─────────────────────────────────────── */
    const id = str(body?.id);
    if (!id) return Response.json({ error: 'Which section? No id was sent.' }, { status: 400 });
    const existing = db.prepare(`SELECT * FROM fssai_sections WHERE id = ?`).get(id) as any;
    if (!existing) return Response.json({ error: 'That section no longer exists.' }, { status: 404 });
    const tpl = db.prepare(`SELECT * FROM fssai_templates WHERE id = ?`).get(existing.template_id) as any;
    if (!tpl) return Response.json({ error: 'That checklist no longer exists.' }, { status: 404 });

    const next = {
      title: body?.title !== undefined ? str(body.title) : existing.title,
      code: body?.code !== undefined ? str(body.code) : existing.code,
      description: body?.description !== undefined ? str(body.description) : existing.description,
      is_active: body?.is_active !== undefined ? toInt01(body.is_active, 1) : existing.is_active,
    };
    if (!next.title) return Response.json({ error: 'Give the section a heading.' }, { status: 400 });
    if (next.code && !/^[A-Za-z0-9._-]{2,48}$/.test(next.code)) {
      return Response.json({ error: 'A code may only contain letters, numbers, dots, dashes and underscores (2-48 characters).' }, { status: 400 });
    }

    const changed = (Object.keys(next) as (keyof typeof next)[])
      .filter((k) => String(existing[k] ?? '') !== String(next[k] ?? ''));
    if (!changed.length) {
      return Response.json({ template: loadFssaiTemplate(db, existing.template_id, { includeRetired: true }), version: tpl.version, changed: [] });
    }

    const save = db.transaction(() => {
      db.prepare(
        `UPDATE fssai_sections SET title=?, code=?, description=?, is_active=?, updated_at=datetime('now') WHERE id=?`,
      ).run(next.title, next.code, next.description, next.is_active, id);
      const version = bumpFssaiTemplateVersion(db, existing.template_id);
      fssaiAudit(db, {
        entity_table: 'fssai_sections', entity_id: id, action: 'update', field: changed.join(','),
        before: Object.fromEntries(changed.map((k) => [k, existing[k]])),
        after: Object.fromEntries(changed.map((k) => [k, (next as any)[k]])),
        reason: `Checklist version ${tpl.version} → ${version}`,
        actor: { email: me.email, name: me.name }, outlet_id: tpl.outlet_id,
      });
      return version;
    });
    const version = save();
    return Response.json({ template: loadFssaiTemplate(db, existing.template_id, { includeRetired: true }), version, changed });
  } catch (e: any) {
    const nice = constraintMessage(e, 'That section could not be saved.');
    if (nice) return Response.json({ error: nice }, { status: 409 });
    console.error('PUT /api/fssai/sections failed:', e);
    return Response.json({ error: e?.message || 'Failed to update the section' }, { status: 500 });
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
    if (!id) return Response.json({ error: 'Which section? No id was sent.' }, { status: 400 });

    const db = getDb();
    const existing = db.prepare(`SELECT * FROM fssai_sections WHERE id = ?`).get(id) as any;
    if (!existing) return Response.json({ error: 'That section no longer exists.' }, { status: 404 });
    const tpl = db.prepare(`SELECT * FROM fssai_templates WHERE id = ?`).get(existing.template_id) as any;
    if (!tpl) return Response.json({ error: 'That checklist no longer exists.' }, { status: 404 });

    // "Only while unused": live questions still in the group block the delete.
    // Retired questions do not — fssai_questions.section_id is ON DELETE SET
    // NULL, so they simply become ungrouped and keep their history.
    const live = (db.prepare(
      `SELECT COUNT(*) AS n FROM fssai_questions WHERE section_id = ? AND is_active = 1`,
    ).get(id) as any).n as number;
    if (live > 0) {
      return Response.json(
        {
          error: `"${existing.title}" still holds ${live} question${live === 1 ? '' : 's'}. Move or remove them first, or switch the section off to hide it.`,
          question_count: live,
        },
        { status: 409 },
      );
    }

    const wipe = db.transaction(() => {
      db.prepare(`DELETE FROM fssai_sections WHERE id = ?`).run(id);
      const version = bumpFssaiTemplateVersion(db, existing.template_id);
      fssaiAudit(db, {
        entity_table: 'fssai_sections', entity_id: id, action: 'delete',
        before: { title: existing.title, template_id: existing.template_id, sort_order: existing.sort_order },
        reason: `Empty section removed — checklist version ${tpl.version} → ${version}`,
        actor: { email: me.email, name: me.name }, outlet_id: tpl.outlet_id,
      });
      return version;
    });
    const version = wipe();
    return Response.json({ ok: true, template: loadFssaiTemplate(db, existing.template_id, { includeRetired: true }), version });
  } catch (e: any) {
    const nice = constraintMessage(e, 'That section could not be removed.');
    if (nice) return Response.json({ error: nice }, { status: 409 });
    console.error('DELETE /api/fssai/sections failed:', e);
    return Response.json({ error: e?.message || 'Failed to remove the section' }, { status: 500 });
  }
}
