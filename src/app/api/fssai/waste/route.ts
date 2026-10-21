/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import { canRunFssaiCheck, fssaiToday, isISODate, parseFssaiDataUri } from '@/lib/fssai';
import {
  requireFssaiUser, fssaiCsrfGuard, fssaiAudit, fssaiAuditBestEffort, fssaiAppAudit, str,
} from '@/lib/fssai-server';
import { fssaiVoidableRecord, fssaiVoidRefusalForRecord } from '@/lib/fssai-void';
import { attachP5Files, type P5AttachmentInput } from '../_p5/records';
import {
  WASTE_TABLE, WASTE_SELECT, WASTE_PAGE, shapeWasteHandover, readWasteHandover, findWasteDuplicate,
  nextWasteHandoverNo, readWasteRegister, readWastePhotos, countActiveWastePhotos, voidWasteAttachment,
  wasteTotals, wasteDaysWithout, lastWasteHandover, judgeWasteRegister, recentWasteCollectors,
  recentWasteHandlers, wasteAgreements, canSeeWasteHandover, addDaysISO,
} from '../_waste/lib';
import {
  WASTE_COLLECTOR_KINDS, WASTE_QTY_UOMS, WASTE_HANDOVER_CADENCE, WASTE_MAX_PHOTOS,
  WASTE_PHOTOS_PER_REQUEST, WASTE_DUPLICATE_WINDOW_MIN,
} from '../_waste/vocab';

/**
 * THE WASTE HANDOVER LOG (/api/fssai/waste) — Hyderabad audit checklist #114,
 * "Waste disposal record". One row per handover at the back door.
 *
 *   GET  ?id=<handover>                     one handover, its photographs and its trail
 *   GET  [?from=&to=&status=live|void|all&q=] the register for those dates (default: the last 30 days)
 *   POST { action: 'record', … }            file a handover (+ up to 2 photographs)
 *   POST { action: 'attach', id, photos }   add a photograph to a filed handover (traced)
 *   POST { action: 'void_photo', id, attachment_id, reason }  void a photograph — the image is kept
 *
 * A HANDOVER ITSELF IS CANCELLED THROUGH /api/fssai/void, never here — that is the
 * module's one void (src/lib/fssai-void.ts). `action: 'void'` is answered with a
 * 409 that names the endpoint, so a screen can follow it.
 *
 * WHO. Reading and filing: any signed-in user (canRunFssaiCheck) — the porter at
 * the back door is the person who sees the waste leave. Staff see restaurant-wide
 * handovers, their own department's and their own; management sees all. Voiding:
 * management only, never the person who filed it (the shared rule).
 *
 * NO MONEY, NO STOCK. There is no money column on the table and this route reads
 * no amount off the body; nothing here moves stock (HARD RULE 5).
 *
 * No DELETE anywhere in this file.
 */
export const dynamic = 'force-dynamic';

/** Placeholder reason used only to ask "could this person void, given a reason?" — never written. */
const VOID_REASON_PROBE = '----';

function normalisePhotos(raw: unknown): P5AttachmentInput[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p: any) => (typeof p === 'string' ? { data_uri: p } : p))
    .filter((p: any) => p && typeof p === 'object')
    .map((p: any) => ({
      data_uri: p.data_uri,
      filename: p.filename,
      caption: p.caption,
      // A receipt is a 'document'; anything else a 'photo'. Never a caller's free word.
      kind: str(p.kind) === 'document' ? 'document' : 'photo',
    }));
}

/**
 * Every photograph checked BEFORE the transaction, so the status is right:
 * 413 for one that is merely too big, 400 for one that is not an image at all.
 * (attachP5Files checks again inside the write and throws — belt and braces.)
 */
function checkPhotos(files: P5AttachmentInput[]): Response | null {
  for (const f of files) {
    const parsed = parseFssaiDataUri(f.data_uri as string);
    if (!parsed.ok) {
      return Response.json({ error: parsed.error, code: `photo_${parsed.code}` }, { status: parsed.code === 'too_big' ? 413 : 400 });
    }
  }
  return null;
}

function photoError(e: any): Response | null {
  const m = String(e?.message || '');
  if (m.startsWith('P5_BAD_PHOTO:')) return Response.json({ error: m.slice('P5_BAD_PHOTO:'.length), code: 'bad_photo' }, { status: 413 });
  if (m.startsWith('P5_TOO_MANY_PHOTOS:')) return Response.json({ error: m.slice('P5_TOO_MANY_PHOTOS:'.length), code: 'too_many_photos' }, { status: 400 });
  return null;
}

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  try {
    const db = getDb();
    const url = new URL(request.url);
    const today = fssaiToday();
    const desc = fssaiVoidableRecord(WASTE_TABLE);

    /* ══ ONE HANDOVER ══════════════════════════════════════════════════════ */
    const id = str(url.searchParams.get('id'));
    if (id) {
      const row = db.prepare(`${WASTE_SELECT} WHERE w.id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That handover no longer exists.' }, { status: 404 });
      if (!canSeeWasteHandover(me, row)) {
        return Response.json({ error: 'That handover belongs to another department.' }, { status: 403 });
      }
      const voidRefusal = desc
        ? fssaiVoidRefusalForRecord(me, row, VOID_REASON_PROBE, desc)
        : 'This register is not yet known to the shared void. Nothing can be cancelled until it is.';
      const trail = db.prepare(
        `SELECT action, field, reason, actor_email, actor_name, created_at
           FROM fssai_audit_log WHERE entity_table = ? AND entity_id = ?
          ORDER BY created_at ASC, rowid ASC`,
      ).all(WASTE_TABLE, id) as any[];
      return Response.json({
        handover: { ...shapeWasteHandover(row), photos: readWastePhotos(db, [id]).get(id) || [] },
        trail: trail.map((t) => ({
          action: String(t.action || ''), field: String(t.field || ''), reason: String(t.reason || ''),
          actor_email: String(t.actor_email || ''), actor_name: String(t.actor_name || ''), at: String(t.created_at || ''),
        })),
        can_void: !voidRefusal,
        void_refusal: voidRefusal,
        void_endpoint: '/api/fssai/void',
        can_attach: canRunFssaiCheck(me) && String(row.status) !== 'void' && !String(row.voided_at || ''),
        can_void_photos: isManagement(me),
        max_photos: WASTE_MAX_PHOTOS,
        photos_per_request: WASTE_PHOTOS_PER_REQUEST,
        has_money_column: false,
      });
    }

    /* ══ THE REGISTER ══════════════════════════════════════════════════════ */
    const to = str(url.searchParams.get('to')) || today;
    const from = str(url.searchParams.get('from')) || addDaysISO(to, -29);
    if (!isISODate(from) || !isISODate(to)) {
      return Response.json({ error: 'The dates must be real dates (YYYY-MM-DD). Use the date pickers.' }, { status: 400 });
    }
    if (from > to) return Response.json({ error: `"From" (${from}) is after "to" (${to}).` }, { status: 400 });
    const status = str(url.searchParams.get('status')) || 'live';
    if (!['live', 'void', 'all'].includes(status)) {
      return Response.json({ error: `"${status}" is not a choice here. Use live, void or all.` }, { status: 400 });
    }

    const reg = readWasteRegister(db, me, { from, to, status, q: str(url.searchParams.get('q')) });
    const last = lastWasteHandover(db);
    const verdict = judgeWasteRegister(last?.business_date || '', today);

    return Response.json({
      from, to, today, status,
      handovers: reg.handovers,
      truncated: reg.truncated,
      totals: wasteTotals(db, from, to, me),
      gaps: wasteDaysWithout(db, from, to, today),
      last: last ? { handover_no: last.handover_no, business_date: last.business_date, handed_at: last.handed_at, collector: last.vendor_name || last.collector_name } : null,
      verdict,
      cadence: WASTE_HANDOVER_CADENCE,
      recent_collectors: recentWasteCollectors(db),
      recent_handlers: recentWasteHandlers(db),
      vendors: db.prepare(`SELECT id, name FROM vendors WHERE is_active = 1 ORDER BY name ASC`).all(),
      departments: db.prepare(`SELECT id, name FROM departments WHERE is_active = 1 ORDER BY name ASC`).all(),
      agreements: wasteAgreements(db),
      collector_kinds: WASTE_COLLECTOR_KINDS,
      uoms: WASTE_QTY_UOMS,
      can_record: canRunFssaiCheck(me),
      is_management: isManagement(me),
      can_void: !!desc && isManagement(me),
      me: { email: me.email || '', name: me.name || '' },
      max_photos: WASTE_MAX_PHOTOS,
      photos_per_request: WASTE_PHOTOS_PER_REQUEST,
      has_money_column: false,
      moves_stock: false,
    });
  } catch (e: any) {
    console.error('GET /api/fssai/waste failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the waste handovers' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { /* validated below */ }

  try {
    const db = getDb();
    const outletId = (await getCurrentOutletId()) || '';
    const today = fssaiToday();
    const action = str(body?.action) || 'record';

    /* ══ VOID A HANDOVER — not here ════════════════════════════════════════ */
    if (action === 'void') {
      return Response.json(
        {
          error: 'A handover is cancelled through the shared void, which keeps the row and its reason. Send { entity_table: "fssai_waste_handovers", id, reason } to /api/fssai/void.',
          use_endpoint: '/api/fssai/void',
          entity_table: WASTE_TABLE,
        },
        { status: 409 },
      );
    }

    /* ══ VOID A PHOTOGRAPH — the image is kept ═════════════════════════════ */
    if (action === 'void_photo') {
      const res = voidWasteAttachment(db, {
        handoverId: str(body?.id), attachmentId: str(body?.attachment_id), reason: str(body?.reason), me, outletId,
      });
      if ('error' in res) return Response.json({ error: res.error }, { status: res.status });
      return Response.json({ ok: true, photo: res.photo, kept: 'The photograph stays on the handover, marked void with your reason.' });
    }

    /* ══ ADD A PHOTOGRAPH TO A FILED HANDOVER ══════════════════════════════ */
    if (action === 'attach') {
      if (!canRunFssaiCheck(me)) return Response.json({ error: 'You are not able to file food-safety records.' }, { status: 403 });
      const id = str(body?.id);
      if (!id) return Response.json({ error: 'Which handover? No id was sent.' }, { status: 400 });
      const row = db.prepare(`SELECT * FROM fssai_waste_handovers WHERE id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That handover no longer exists.' }, { status: 404 });
      if (!canSeeWasteHandover(me, row)) return Response.json({ error: 'That handover belongs to another department.' }, { status: 403 });
      if (String(row.status) === 'void' || String(row.voided_at || '')) {
        return Response.json({ error: 'That handover has been voided, so it is closed evidence and nothing more can be added to it.' }, { status: 409 });
      }
      const files = normalisePhotos(body?.photos);
      if (!files.length) return Response.json({ error: 'No photograph was sent.' }, { status: 400 });
      if (files.length > WASTE_PHOTOS_PER_REQUEST) {
        return Response.json({ error: `Send up to ${WASTE_PHOTOS_PER_REQUEST} photographs at a time; this sent ${files.length}.`, code: 'too_many_photos' }, { status: 400 });
      }
      const already = countActiveWastePhotos(db, id);
      if (already + files.length > WASTE_MAX_PHOTOS) {
        return Response.json({ error: `A handover can carry up to ${WASTE_MAX_PHOTOS} photographs; this one already has ${already}.`, code: 'too_many_photos' }, { status: 400 });
      }
      const bad = checkPhotos(files);
      if (bad) return bad;

      let added: ReturnType<typeof attachP5Files> = [];
      try {
        db.transaction(() => {
          added = attachP5Files(db, { entityTable: WASTE_TABLE, entityId: id, files, actor: { email: me.email, name: me.name }, outletId });
          /* A CHANGE TO A FILED RECORD — traced or not made. fssaiAudit throws,
           * which rolls the attachment back with it. */
          fssaiAudit(db, {
            entity_table: WASTE_TABLE, entity_id: id, action: 'update', field: 'attachments',
            before: { active_photos: already },
            after: { active_photos: already + added.length, added: added.map((a) => ({ id: a.id, kind: a.kind, mime: a.mime, size_bytes: a.size_bytes })) },
            reason: 'Photograph added to a filed handover.',
            actor: { email: me.email, name: me.name }, outlet_id: outletId || row.outlet_id,
          });
          db.prepare(`UPDATE fssai_waste_handovers SET updated_at = datetime('now') WHERE id = ?`).run(id);
        })();
      } catch (e: any) {
        const r = photoError(e);
        if (r) return r;
        throw e;
      }
      return Response.json({ ok: true, added, photos: readWastePhotos(db, [id]).get(id) || [] });
    }

    if (action !== 'record') {
      return Response.json({ error: `"${action}" is not something this log does. Use record, attach or void_photo.` }, { status: 400 });
    }

    /* ══ FILE A HANDOVER ═══════════════════════════════════════════════════ */
    if (!canRunFssaiCheck(me)) return Response.json({ error: 'You are not able to file food-safety records.' }, { status: 403 });

    const read = readWasteHandover(db, body, me, today);
    if (!read.ok) return Response.json({ error: read.error, code: read.code }, { status: read.status });
    const v = read.v;

    const files = normalisePhotos(body?.photos);
    if (files.length > WASTE_PHOTOS_PER_REQUEST) {
      return Response.json(
        { error: `Attach up to ${WASTE_PHOTOS_PER_REQUEST} photographs while filing; add the rest from the handover afterwards. This sent ${files.length}.`, code: 'too_many_photos' },
        { status: 400 },
      );
    }
    const badPhoto = checkPhotos(files);
    if (badPhoto) return badPhoto;

    const id = generateId();
    let handoverNo = '';
    let duplicate: ReturnType<typeof findWasteDuplicate> = null;
    let attached: ReturnType<typeof attachP5Files> = [];

    const write = db.transaction(() => {
      /* Inside the transaction, so a double-tap racing itself sees the first row. */
      duplicate = findWasteDuplicate(db, v, me, outletId);
      if (duplicate) return;
      handoverNo = nextWasteHandoverNo(db, v.business_date, outletId);
      db.prepare(
        `INSERT INTO fssai_waste_handovers
           (id, handover_no, business_date, handed_at, wet_qty, dry_qty, other_qty, other_kind, qty_uom,
            collector_kind, collector_name, vendor_id, agency_reg_no, receipt_no, vehicle_no,
            received_by_name, handed_over_name, department_id, document_id, note,
            status, recorded_by, recorded_name, outlet_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?)`,
      ).run(
        id, handoverNo, v.business_date, v.handed_at, v.wet_qty, v.dry_qty, v.other_qty, v.other_kind, v.qty_uom,
        v.collector_kind, v.collector_name, v.vendor_id, v.agency_reg_no, v.receipt_no, v.vehicle_no,
        v.received_by_name, v.handed_over_name, v.department_id, v.document_id, v.note,
        me.email || '', me.name || '', outletId,
      );
      attached = attachP5Files(db, { entityTable: WASTE_TABLE, entityId: id, files, actor: { email: me.email, name: me.name }, outletId });
      /* §7 Q4: a handover somebody really made is never lost because its trail
       * row would not insert — best-effort here, and loud in the log if it fails. */
      fssaiAuditBestEffort(db, {
        entity_table: WASTE_TABLE, entity_id: id, action: 'create',
        after: {
          handover_no: handoverNo, business_date: v.business_date, handed_at: v.handed_at,
          wet_qty: v.wet_qty, dry_qty: v.dry_qty, other_qty: v.other_qty, other_kind: v.other_kind, qty_uom: v.qty_uom,
          collector_kind: v.collector_kind, collector_name: v.collector_name, vendor_id: v.vendor_id,
          agency_reg_no: v.agency_reg_no, receipt_no: v.receipt_no, vehicle_no: v.vehicle_no,
          handed_over_name: v.handed_over_name, received_by_name: v.received_by_name,
          department_id: v.department_id, document_id: v.document_id, photos: attached.length,
        },
        reason: v.backdated ? `Filed on ${today} for ${v.business_date}.` : '',
        actor: { email: me.email, name: me.name }, outlet_id: outletId,
      });
    });

    try {
      write();
    } catch (e: any) {
      const r = photoError(e);
      if (r) return r;
      throw e;
    }

    if (duplicate) {
      const d = duplicate as { rule: 'receipt' | 'resubmit'; row: any };
      const no = String(d.row.handover_no || '');
      return Response.json(
        {
          error: d.rule === 'receipt'
            ? `Receipt ${v.receipt_no} from ${v.collector_name} is already filed as ${no} (${d.row.business_date}). If this is a different receipt, check the number.`
            : `This looks like the handover you saved a moment ago (${no}). It was not saved twice. If it really was a second load, change the time.`,
          code: d.rule === 'receipt' ? 'duplicate_receipt' : 'duplicate_submit',
          duplicate_of: { id: String(d.row.id), handover_no: no, business_date: String(d.row.business_date) },
          window_minutes: WASTE_DUPLICATE_WINDOW_MIN,
        },
        { status: 409 },
      );
    }

    fssaiAppAudit(db, {
      event_type: 'fssai.waste_handover.record', entity_type: WASTE_TABLE, entity_id: id, actor_email: me.email,
      after: { handover_no: handoverNo, collector_kind: v.collector_kind, collector_name: v.collector_name, wet_qty: v.wet_qty, dry_qty: v.dry_qty, other_qty: v.other_qty },
    });

    const fresh = db.prepare(`${WASTE_SELECT} WHERE w.id = ?`).get(id) as any;
    const warnings: string[] = [];
    if (!v.receipt_no && !v.vehicle_no) warnings.push('No receipt or vehicle number on this handover — the note you wrote is what an inspector will read.');
    if (v.collector_kind === 'agency' && !v.agency_reg_no) warnings.push('No registration number for the agency — the note you wrote is what an inspector will read.');
    return Response.json({
      ok: true,
      handover: { ...shapeWasteHandover(fresh), photos: readWastePhotos(db, [id]).get(id) || [] },
      backdated: v.backdated,
      page: WASTE_PAGE,
      has_money_column: false,
      stock_unchanged: true,
      ...(warnings.length ? { warning: warnings.join(' ') } : {}),
    });
  } catch (e: any) {
    console.error('POST /api/fssai/waste failed:', e);
    return Response.json({ error: e?.message || 'Failed to save the handover' }, { status: 500 });
  }
}

/* No DELETE. A handover is voided with a written reason through /api/fssai/void;
 * a photograph is voided here with action 'void_photo' and its image is kept. */
