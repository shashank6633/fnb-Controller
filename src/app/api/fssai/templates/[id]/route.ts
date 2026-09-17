/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canAuthorFssai, qtypeMeta } from '@/lib/fssai';
import {
  requireFssaiAdmin, loadFssaiTemplate, fssaiAudit, fssaiAppAudit, str,
} from '@/lib/fssai-server';

/**
 * ONE CHECKLIST — read it, and move it through its life
 * (/api/fssai/templates/[id]).
 *
 * GET  → { template: { ...header, sections[], questions[], counts } }
 *        Any signed-in user may read a PUBLISHED checklist. Drafts and
 *        archived ones are admin-only. `?include_retired=1` (admin) also
 *        returns questions and sections that were retired — the builder needs
 *        them, a runner must never see them.
 *
 * POST { action } → publish | unpublish | archive | restore.  ADMIN.
 *
 * THE PUBLISHING FLOW is hr_sop_versions' (api/hr/sops/route.ts:598-608),
 * reduced to one row: a STATUS-GUARDED update whose `changes !== 1` is a clean
 * 409 rather than a silent double-write. Every decision route in this module
 * uses that shape — it is the only concurrency control that actually holds.
 *
 * WHY THERE IS NO DELETE HERE: removing a checklist is an archive, and it
 * lives on the collection route (DELETE /api/fssai/templates?id=). Owner §19 —
 * a record with history is voided with a reason, never deleted.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const admin = canAuthorFssai(me);
    const includeRetired = admin && url.searchParams.get('include_retired') === '1';

    const db = getDb();
    const template = loadFssaiTemplate(db, id, { includeRetired });
    if (!template) return Response.json({ error: 'That checklist no longer exists.' }, { status: 404 });
    if (!admin && (template.status !== 'published' || !template.is_active)) {
      // Not 404 — it exists; it is simply not published. Saying so is honest
      // and tells staff to ask an administrator rather than hunt for a bug.
      return Response.json({ error: 'That checklist has not been published yet.' }, { status: 403 });
    }

    // A question whose type this build does not know must be VISIBLE as a
    // problem, never rendered as a blank field (RECON §10 R1).
    const unknown = (template.questions as any[]).filter((q) => !q.qtype_known).map((q) => q.qtype);
    return Response.json({
      template,
      can_author: admin,
      unknown_qtypes: Array.from(new Set(unknown)),
    });
  } catch (e: any) {
    console.error('GET /api/fssai/templates/[id] failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the checklist' }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireFssaiAdmin();
  if ('resp' in g) return g.resp;
  const me = g.me;

  try {
    const { id } = await params;
    let body: any = {};
    try { body = await request.json(); } catch { /* validated below */ }
    const action = str(body?.action);
    const reason = str(body?.reason);

    const db = getDb();
    const tpl = db.prepare(`SELECT * FROM fssai_templates WHERE id = ?`).get(id) as any;
    if (!tpl) return Response.json({ error: 'That checklist no longer exists.' }, { status: 404 });
    const runCount = (db.prepare(`SELECT COUNT(*) AS n FROM fssai_runs WHERE template_id = ?`).get(id) as any).n as number;

    /* ── PUBLISH ─────────────────────────────────────────────────────────── */
    if (action === 'publish') {
      const questions = db
        .prepare(`SELECT id, qtype, prompt FROM fssai_questions WHERE template_id = ? AND is_active = 1`)
        .all(id) as any[];
      if (!questions.length) {
        // HRMS precedent: 'This test has no questions yet' (tests/route.ts:372).
        return Response.json({ error: 'This checklist has no questions yet, so there is nothing to run.' }, { status: 400 });
      }
      const unknown = questions.filter((q) => !qtypeMeta(q.qtype));
      if (unknown.length) {
        return Response.json(
          {
            error: `This checklist contains ${unknown.length} question${unknown.length === 1 ? '' : 's'} of a type this system does not know (${Array.from(new Set(unknown.map((u) => u.qtype))).join(', ')}). Fix them before publishing.`,
          },
          { status: 400 },
        );
      }

      const publish = db.transaction(() => {
        // Status-guarded claim: a lost race with another admin publishing the
        // same checklist rolls back as a clean 409, never a double-write.
        const res = db.prepare(
          `UPDATE fssai_templates
              SET status='published', is_active=1, published_by=?, published_at=datetime('now'),
                  updated_at=datetime('now')
            WHERE id=? AND status <> 'published'`,
        ).run(me.email || '', id);
        if (res.changes !== 1) throw new Error('FSSAI_TEMPLATE_ALREADY_PUBLISHED');
        fssaiAudit(db, {
          entity_table: 'fssai_templates', entity_id: id, action: 'update', field: 'status',
          before: { status: tpl.status }, after: { status: 'published', version: tpl.version, questions: questions.length },
          reason: reason || 'Published',
          actor: { email: me.email, name: me.name }, outlet_id: tpl.outlet_id,
        });
      });
      try {
        publish();
      } catch (e: any) {
        if (String(e?.message) === 'FSSAI_TEMPLATE_ALREADY_PUBLISHED') {
          return Response.json({ error: 'This checklist is already published.' }, { status: 409 });
        }
        throw e;
      }
      fssaiAppAudit(db, {
        event_type: 'fssai.template.publish', entity_type: 'fssai_templates', entity_id: id,
        actor_email: me.email, after: { version: tpl.version },
      });
      return Response.json({ template: loadFssaiTemplate(db, id, { includeRetired: true }) });
    }

    /* ── UNPUBLISH — back to draft, and only while nothing has been run ──── */
    if (action === 'unpublish') {
      if (tpl.status !== 'published') {
        return Response.json({ error: 'That checklist is not published.' }, { status: 409 });
      }
      if (runCount > 0) {
        return Response.json(
          {
            error: `${runCount} check${runCount === 1 ? ' has' : 's have'} already been recorded against this checklist, so it cannot go back to a draft. Archive it instead — the records stay readable and no new checks can be started.`,
          },
          { status: 409 },
        );
      }
      const back = db.transaction(() => {
        const res = db.prepare(
          `UPDATE fssai_templates SET status='draft', published_by='', published_at='', updated_at=datetime('now')
            WHERE id=? AND status='published'`,
        ).run(id);
        if (res.changes !== 1) throw new Error('FSSAI_TEMPLATE_NOT_PUBLISHED');
        fssaiAudit(db, {
          entity_table: 'fssai_templates', entity_id: id, action: 'update', field: 'status',
          before: { status: 'published' }, after: { status: 'draft' },
          reason: reason || 'Withdrawn to draft before it was ever run',
          actor: { email: me.email, name: me.name }, outlet_id: tpl.outlet_id,
        });
      });
      try { back(); } catch (e: any) {
        if (String(e?.message) === 'FSSAI_TEMPLATE_NOT_PUBLISHED') {
          return Response.json({ error: 'That checklist is not published.' }, { status: 409 });
        }
        throw e;
      }
      return Response.json({ template: loadFssaiTemplate(db, id, { includeRetired: true }) });
    }

    /* ── ARCHIVE ─────────────────────────────────────────────────────────── */
    if (action === 'archive') {
      if (tpl.status === 'archived' && !tpl.is_active) {
        return Response.json({ error: 'That checklist is already archived.' }, { status: 409 });
      }
      let stood = 0;
      const archive = db.transaction(() => {
        const res = db.prepare(
          `UPDATE fssai_templates SET status='archived', is_active=0, updated_at=datetime('now')
            WHERE id=? AND status <> 'archived'`,
        ).run(id);
        if (res.changes !== 1) throw new Error('FSSAI_TEMPLATE_ALREADY_ARCHIVED');
        stood = db.prepare(
          `UPDATE fssai_assignments SET is_active=0, updated_at=datetime('now') WHERE template_id=? AND is_active=1`,
        ).run(id).changes;
        fssaiAudit(db, {
          entity_table: 'fssai_templates', entity_id: id, action: 'update', field: 'status',
          before: { status: tpl.status }, after: { status: 'archived', assignments_stood_down: stood },
          reason: reason || 'Archived',
          actor: { email: me.email, name: me.name }, outlet_id: tpl.outlet_id,
        });
      });
      try { archive(); } catch (e: any) {
        if (String(e?.message) === 'FSSAI_TEMPLATE_ALREADY_ARCHIVED') {
          return Response.json({ error: 'That checklist is already archived.' }, { status: 409 });
        }
        throw e;
      }
      fssaiAppAudit(db, {
        event_type: 'fssai.template.archive', entity_type: 'fssai_templates', entity_id: id,
        actor_email: me.email, after: { status: 'archived' },
      });
      return Response.json({
        template: loadFssaiTemplate(db, id, { includeRetired: true }),
        assignments_stood_down: stood,
        run_count: runCount,
      });
    }

    /* ── RESTORE — an archived checklist comes back as a DRAFT ───────────── */
    if (action === 'restore') {
      if (tpl.status !== 'archived') {
        return Response.json({ error: 'That checklist is not archived.' }, { status: 409 });
      }
      const restore = db.transaction(() => {
        const res = db.prepare(
          `UPDATE fssai_templates SET status='draft', is_active=1, published_by='', published_at='',
                  updated_at=datetime('now')
            WHERE id=? AND status='archived'`,
        ).run(id);
        if (res.changes !== 1) throw new Error('FSSAI_TEMPLATE_NOT_ARCHIVED');
        fssaiAudit(db, {
          entity_table: 'fssai_templates', entity_id: id, action: 'update', field: 'status',
          before: { status: 'archived' }, after: { status: 'draft' },
          // Deliberately NOT straight back to published: it comes back as a
          // draft so the admin re-reads it and publishes on purpose.
          reason: reason || 'Restored from the archive as a draft',
          actor: { email: me.email, name: me.name }, outlet_id: tpl.outlet_id,
        });
      });
      try { restore(); } catch (e: any) {
        if (String(e?.message) === 'FSSAI_TEMPLATE_NOT_ARCHIVED') {
          return Response.json({ error: 'That checklist is not archived.' }, { status: 409 });
        }
        throw e;
      }
      return Response.json({ template: loadFssaiTemplate(db, id, { includeRetired: true }) });
    }

    return Response.json(
      { error: `"${action || '(none)'}" is not something that can be done to a checklist. Use publish, unpublish, archive or restore.` },
      { status: 400 },
    );
  } catch (e: any) {
    console.error('POST /api/fssai/templates/[id] failed:', e);
    return Response.json({ error: e?.message || 'That action could not be completed' }, { status: 500 });
  }
}
