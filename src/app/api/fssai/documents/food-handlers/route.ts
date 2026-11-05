/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import { canManageFssaiCa, fssaiToday, fssaiDocType, FSSAI_DOC_TYPES } from '@/lib/fssai';
import { requireFssaiUser, fssaiCsrfGuard, fssaiAppAudit, str } from '@/lib/fssai-server';
import {
  fssaiVoidableRecord, fssaiVoidRefusalForRecord, voidFssaiRecord,
} from '@/lib/fssai-void';
import {
  readFssaiFoodHandlerCoverage, readFssaiHandlerCandidates, readFssaiTrainingLinks,
  createFssaiFoodHandler, updateFssaiFoodHandler, markFssaiHandlerLeft, markFssaiHandlerRejoined,
  importFssaiFoodHandlers, linkFssaiTraining, updateFssaiTrainingLink,
  FSSAI_HANDLER_REQUIREMENTS, FSSAI_HANDLER_VERDICTS, FSSAI_HANDLER_STATUSES, FSSAI_HANDLER_SOURCES,
  FSSAI_HANDLER_DOC_TYPES, FSSAI_TRAINING_LINK_COUNTS_AS, FSSAI_FOSTAC_HANDLERS_PER_SUPERVISOR,
} from '@/lib/fssai-food-handlers';
import { documentFilesFor } from '../files';

/**
 * THE FOOD-HANDLER REGISTER — /api/fssai/documents/food-handlers
 * (Hyderabad audit #55 #56 #106 #107; owner ruling Q18 of 2026-10-14.)
 *
 * The list of PEOPLE who handle food, with or without a login, and — derived on
 * every read — whether each has a medical fitness certificate, food-safety
 * training and (for the supervisor) a FoSTaC certificate that is valid, expiring
 * or MISSING. The rules and the measured defect are in src/lib/fssai-food-handlers.ts.
 *
 * It lives under /documents on purpose: the certificates are documents (filed
 * through /api/fssai/documents with handler_id), and the page at
 * /fssai/documents/food-handlers inherits that page's management-only gate and
 * its page-access grant by prefix — a manager who can open the cupboard can open
 * the register, and nobody else.
 *
 *   GET  [?include_left=1]                the register with coverage (+ links, HR facts)
 *   GET  ?id=<id>                         one person: coverage, every certificate (live,
 *                                         renewed, voided) with its files, HRMS completions
 *   GET  ?candidates=hrms|users           people HRMS / the logins know who are not on it
 *   GET  ?format=csv                      the coverage list, for the audit file or print
 *   POST { action: 'create' | 'update' | 'leave' | 'rejoin' | 'import' | 'void'
 *                | 'link_training' | 'update_link', … }
 *
 * Management only (the API is the gate; the catalog is visibility). NO DELETE:
 * a mistake is voided with a reason (the shared §19 writer); a person who leaves
 * is 'left' and keeps their row. Every write lands in fssai_audit_log inside the
 * same transaction (fssaiAudit throws, so no trace = no write).
 */
export const dynamic = 'force-dynamic';

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  // A leading = + - @ is a formula in a spreadsheet; quote it so it stays text.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) || safe !== s ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;
  if (!isManagement(me)) {
    return Response.json({ error: 'The food-handler register is management only.' }, { status: 403 });
  }
  try {
    const db = getDb();
    const url = new URL(request.url);
    const today = fssaiToday();

    const candidates = str(url.searchParams.get('candidates'));
    if (candidates) {
      if (candidates !== 'hrms' && candidates !== 'users') {
        return Response.json({ error: 'Candidates come from HRMS or from the staff logins.' }, { status: 400 });
      }
      return Response.json({ source: candidates, candidates: readFssaiHandlerCandidates(db, candidates) });
    }

    const id = str(url.searchParams.get('id'));
    if (id) {
      const cov = readFssaiFoodHandlerCoverage(db, { today, includeLeft: true, ids: [id] });
      let handler: any = cov.handlers[0] || null;
      if (!handler) {
        // A voided row is not in the coverage read — show it as it stands, closed.
        const row = db.prepare(`SELECT * FROM fssai_food_handlers WHERE id = ?`).get(id) as any;
        if (!row) return Response.json({ error: 'That person is not on the register.' }, { status: 404 });
        handler = { ...row, coverage: null, in_order: false, problems: [] };
      }
      // Every certificate ever filed for this person — current, renewed and voided —
      // so the history is on one screen. Matched the same way coverage matches.
      const docs = db.prepare(
        `SELECT d.* FROM fssai_documents d
          WHERE d.doc_type IN (${FSSAI_HANDLER_DOC_TYPES.map(() => '?').join(',')})
            AND (d.handler_id = ? OR (d.handler_id = '' AND ? <> '' AND lower(d.person_email) = lower(?)))
          ORDER BY d.doc_type, d.is_active DESC, d.expiry_date DESC, d.created_at DESC`,
      ).all(...FSSAI_HANDLER_DOC_TYPES, id, str(handler.person_email), str(handler.person_email)) as any[];
      const files = documentFilesFor(db, docs.map((d) => String(d.id)), { withImage: true });
      const trail = db.prepare(
        `SELECT action, field, before_json, after_json, reason, actor_email, actor_name, created_at
           FROM fssai_audit_log WHERE entity_table = 'fssai_food_handlers' AND entity_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT 50`,
      ).all(id) as any[];
      return Response.json({
        handler,
        certificates: docs.map((d) => ({
          id: String(d.id), doc_type: str(d.doc_type), type_label: fssaiDocType(str(d.doc_type))?.label || str(d.doc_type),
          title: str(d.title), reference_no: str(d.reference_no), issuer: str(d.issuer),
          issued_on: str(d.issued_on), expiry_date: str(d.expiry_date), is_active: Number(d.is_active) === 1,
          status: str(d.voided_at) ? 'void' : str(d.status), void_reason: str(d.void_reason),
          matched_by: str(d.handler_id) ? 'handler_id' : 'person_email',
          files: files.get(String(d.id)) || [],
        })),
        trail,
        can_void: canManageFssaiCa(me),
        today,
      });
    }

    const coverage = readFssaiFoodHandlerCoverage(db, { today, includeLeft: str(url.searchParams.get('include_left')) === '1' });

    if (str(url.searchParams.get('format')) === 'csv') {
      const head = ['Handler no', 'Name', 'Designation', 'Department', 'Status', 'Identified by',
        'Medical', 'Medical expires', 'Training', 'Training expires', 'FoSTaC supervisor', 'FoSTaC', 'FoSTaC expires', 'In order'];
      const lines = [head.map(csvCell).join(',')];
      for (const h of coverage.handlers) {
        const c = h.coverage;
        lines.push([
          h.handler_no, h.full_name, h.designation, h.department_name, h.status_label,
          h.key_kind === 'hrms' ? `HRMS ${h.employee_code}` : h.key_kind === 'login' ? h.person_email : 'Name only',
          c.medical.verdict_label, c.medical.best?.expiry_date || '',
          c.training.verdict_label, c.training.best?.expiry_date || '',
          h.is_fostac_supervisor ? 'Yes' : 'No', c.fostac.verdict_label, c.fostac.best?.expiry_date || '',
          h.status === 'active' ? (h.in_order ? 'Yes' : 'NO') : '',
        ].map(csvCell).join(','));
      }
      return new Response('﻿' + lines.join('\r\n') + '\r\n', {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="food-handlers-${today}.csv"`,
          'cache-control': 'no-store',
        },
      });
    }

    const links = readFssaiTrainingLinks(db);
    const departments = db.prepare(`SELECT id, name FROM departments ORDER BY lower(name)`).all();
    const logins = db.prepare(`SELECT lower(email) AS email, name FROM users WHERE is_active = 1 ORDER BY lower(name), lower(email)`).all();
    return Response.json({
      ...coverage,
      training_links: links.links,
      hr_trainings: links.hr_trainings,
      requirements: FSSAI_HANDLER_REQUIREMENTS.map((r) => ({ key: r.key, label: r.label, lines: r.lines, doc_types: r.doc_types, no_expiry_ok: r.no_expiry_ok })),
      verdicts: FSSAI_HANDLER_VERDICTS,
      statuses: FSSAI_HANDLER_STATUSES,
      sources: FSSAI_HANDLER_SOURCES,
      person_doc_types: FSSAI_DOC_TYPES.filter((t) => t.scope === 'person'),
      link_counts_as: FSSAI_TRAINING_LINK_COUNTS_AS.map((k) => ({ key: k, label: fssaiDocType(k)?.label || k })),
      handlers_per_supervisor: FSSAI_FOSTAC_HANDLERS_PER_SUPERVISOR,
      departments,
      logins,
      can_void: canManageFssaiCa(me),
      me: me.email,
      generated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('GET /api/fssai/documents/food-handlers failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the food-handler register' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;
  if (!isManagement(me)) {
    return Response.json({ error: 'The food-handler register is management only.' }, { status: 403 });
  }
  let body: any = {};
  try { body = await request.json(); } catch { body = {}; }
  const action = str(body.action);
  const actor = { email: me.email, name: me.name };

  try {
    const db = getDb();
    const outletId = (await getCurrentOutletId()) || '';
    const today = fssaiToday();
    const fail = (out: { error: string; status: number; code?: string; existing_id?: string }) =>
      Response.json({ error: out.error, code: out.code, existing_id: out.existing_id }, { status: out.status });

    if (action === 'create') {
      const out = db.transaction(() => createFssaiFoodHandler(db, { body, actor, outletId }))();
      if ('error' in out) return fail(out);
      fssaiAppAudit(db, {
        event_type: 'fssai_food_handler_create', entity_type: 'fssai_food_handlers', entity_id: out.handler.id,
        actor_email: me.email, after: { handler_no: out.handler.handler_no, full_name: out.handler.full_name }, note: out.handler.full_name,
      });
      return Response.json({ handler: out.handler, warnings: out.warnings, created: true });
    }

    if (action === 'import') {
      const source = str(body.source);
      if (source !== 'hrms' && source !== 'users') {
        return Response.json({ error: 'Import from HRMS or from the staff logins.' }, { status: 400 });
      }
      const ids = Array.isArray(body.ids) ? body.ids.map((x: unknown) => str(x)).filter(Boolean) : [];
      if (!ids.length) return Response.json({ error: 'Pick at least one person to add.' }, { status: 400 });
      const out = db.transaction(() => importFssaiFoodHandlers(db, {
        source, ids, is_food_handler: body.is_food_handler, actor, outletId,
      }))();
      fssaiAppAudit(db, {
        event_type: 'fssai_food_handler_import', entity_type: 'fssai_food_handlers', entity_id: '',
        actor_email: me.email, after: { source, created: out.created.length, linked: out.linked.length, skipped: out.skipped.length },
      });
      return Response.json(out);
    }

    if (action === 'link_training') {
      const out = db.transaction(() => linkFssaiTraining(db, {
        hr_training_id: body.hr_training_id, counts_as: body.counts_as, valid_months: body.valid_months,
        note: body.note, actor, outletId,
      }))();
      if ('error' in out) return fail(out);
      return Response.json({ link: out.link, created: true });
    }

    if (action === 'update_link') {
      const out = db.transaction(() => updateFssaiTrainingLink(db, {
        id: body.id, counts_as: body.counts_as, valid_months: body.valid_months,
        is_active: body.is_active, note: body.note, reason: body.reason, actor, outletId,
      }))();
      if ('error' in out) return fail(out);
      return Response.json({ link: out.link, updated: true });
    }

    const id = str(body.id);
    if (!id) return Response.json({ error: 'Which person?' }, { status: 400 });

    if (action === 'update') {
      const out = db.transaction(() => updateFssaiFoodHandler(db, { id, body, actor, outletId }))();
      if ('error' in out) return fail(out);
      return Response.json({ handler: out.handler, warnings: out.warnings, changed: out.changed, updated: true });
    }

    if (action === 'leave') {
      const out = db.transaction(() => markFssaiHandlerLeft(db, { id, left_on: body.left_on, note: body.note, actor, outletId, today }))();
      if ('error' in out) return fail(out);
      return Response.json({ handler: out.handler, left: true });
    }

    if (action === 'rejoin') {
      const out = db.transaction(() => markFssaiHandlerRejoined(db, { id, joined_on: body.joined_on, note: body.note, actor, outletId, today }))();
      if ('error' in out) return fail(out);
      return Response.json({ handler: out.handler, rejoined: true });
    }

    /* VOID — a person entered by MISTAKE, through the module's one §19 writer.
     * Someone who left is 'leave', never this. */
    if (action === 'void') {
      const desc = fssaiVoidableRecord('fssai_food_handlers');
      if (!desc) {
        return Response.json({ error: 'The register is missing from the void list (FSSAI_RECORD_TABLES). Nothing was changed.' }, { status: 500 });
      }
      const row = db.prepare(`SELECT * FROM fssai_food_handlers WHERE id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That person is not on the register.' }, { status: 404 });
      const reason = str(body.reason).trim();
      const refusal = fssaiVoidRefusalForRecord(me as any, row, reason, desc);
      if (refusal) return Response.json({ error: refusal }, { status: /signed in/i.test(refusal) ? 401 : /already/i.test(refusal) ? 409 : /reason|words/i.test(refusal) ? 400 : 403 });
      const res = voidFssaiRecord(db, { desc, row, reason, actor: { email: me.email, name: me.name, role: me.role }, outletId });
      if ('conflict' in res) return Response.json({ error: res.conflict }, { status: 409 });
      fssaiAppAudit(db, {
        event_type: 'fssai_food_handler_void', entity_type: 'fssai_food_handlers', entity_id: id,
        actor_email: me.email, after: { status: 'void', void_reason: reason }, note: reason,
      });
      return Response.json({ voided: true, result: res });
    }

    return Response.json({ error: `"${action || '(none)'}" is not something this register can do.` }, { status: 400 });
  } catch (e: any) {
    console.error('POST /api/fssai/documents/food-handlers failed:', e);
    const m = String(e?.message || '');
    if (/UNIQUE constraint failed: fssai_food_handlers/.test(m)) {
      return Response.json({ error: 'That person is already on the register (the same HRMS record, login or number).' }, { status: 409 });
    }
    if (/UNIQUE constraint failed: fssai_training_links/.test(m)) {
      return Response.json({ error: 'That HRMS training is already mapped.' }, { status: 409 });
    }
    return Response.json({ error: m || 'Could not save the register' }, { status: 500 });
  }
}
