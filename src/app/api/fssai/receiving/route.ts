/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import {
  FSSAI_RECEIVING_CHECKPOINTS, FSSAI_RECEIVING_DECISIONS, FSSAI_REJECT_REASONS,
  FSSAI_CHECK_RESULTS, FSSAI_SHIFTS, FSSAI_RECORD_STATUSES, FSSAI_TEMP_UOMS,
  isFssaiCheckResult, fssaiCheckResultIsFail, fssaiCheckResultAnswered, fssaiCheckResultLabel,
  fssaiReceivingDecisionFor, fssaiReceivingDecisionMeta, fssaiRecordStatusMeta,
  fssaiRecordIsEditable, fssaiVoidRefusal, canVerifyFssai, fssaiToday, isISODate,
  addDaysISO, daysBetweenISO, isFssaiShift, fssaiDisplayReading, fssaiExpiryState,
  fssaiExpiryStateMeta, FSSAI_NEAR_EXPIRY_DAYS,
} from '@/lib/fssai';
import {
  requireFssaiUser, fssaiCsrfGuard, fssaiAudit, fssaiAuditBestEffort, fssaiAppAudit,
  str, FSSAI_NO_MATCH,
} from '@/lib/fssai-server';
import {
  nextFssaiReceivingNo, resolveFssaiRange, writeFssaiAttachment, fssaiAttachmentCounts,
  fssaiRecordVisibility, fssaiClock, fssaiNum, fssaiInt, FSSAI_BACKDATE_DAYS,
  fssaiReceivingLineFails as lineFails, fssaiReceivingLineGaps as lineGaps,
} from '../_p4/lib';

/**
 * RECEIVING QC (/api/fssai/receiving) — owner §2: check the delivery at the door.
 *
 * ── WHY THIS IS NOT A SECOND GOODS-RECEIPT SCREEN ───────────────────────────
 * It is not, and that is the first thing to understand about this route. The GRN
 * screen already records WHAT ARRIVED and already has a hold (`src/lib/grn-qc.ts`)
 * that keeps a delivery as `awaiting_qc` until the kitchen or the store signs.
 * This route records WHETHER IT WAS FIT, line by line, and it READS the GRN to do
 * it — `?grn_id=` pulls the vendor, the invoice and every received line straight
 * off `goods_receipt_notes` / `goods_receipt_note_items`, so nobody types a
 * delivery twice. HARD RULE 5 is untouched: NOTHING HERE MOVES STOCK. Accepting or
 * rejecting a line on this record changes no quantity anywhere in the inventory —
 * the stock figure stays the GRN's, which is the module that owns it.
 *
 * ── THE MEASUREMENT THAT SHAPED IT ──────────────────────────────────────────
 * `goods_receipt_notes` carries six INTEGER `qc_` tick-boxes, and on the live
 * snapshot there are 29 GRNs with all six columns summing to 0 on every one of
 * them. A 0 there cannot tell "checked and wrong" from "nobody ticked it", which
 * are opposite statements about a delivery. So every checkpoint here is
 * `FssaiCheckResult` — `''` not assessed · `ok` · `not_ok` · `na` — only `not_ok`
 * is a failure, and `''` is never counted as a pass. (Owner's Q21.)
 *
 * ── THE LIFECYCLE ───────────────────────────────────────────────────────────
 *   draft → submitted → verified          void (management, written reason)
 * A DRAFT is editable: lines are added, quantities and tick-boxes change, lines
 * can be removed. The moment it is SUBMITTED the verdict is frozen — `is_fail` per
 * line, `fail_count`, `rejected_count`, `outcome` — and nothing can edit it again.
 * There is no 'rejected' status: a delivery inspection is an observation of a
 * moment that has passed, so there is nothing to redo. A record entered in error is
 * voided with a reason; a problem with the goods raises a CORRECTIVE ACTION
 * (owner's Q14 ruling).
 *
 *   GET  ?id=<id>                      one inspection with its lines and photographs
 *   GET  ?grn_id=<id>&prefill=1        the GRN's own lines, ready to inspect
 *   GET  ?open_grns=1                  deliveries with no inspection yet
 *   GET  ?photo_id=<id>                one photograph
 *   GET  [?from=&to=&vendor_id=&status=&fails=1&q=]
 *   POST { action: 'create'|'save_header'|'save_line'|'remove_line'|'submit'
 *                  |'verify'|'void'|'attach', … }
 */
export const dynamic = 'force-dynamic';

const LIST_LIMIT = 200;

/** The vehicle-level checkpoints, which are on the HEADER and not on a line. */
const VEHICLE_CHECKPOINTS: readonly { key: string; column: string; label: string; hint: string }[] = [
  { key: 'vehicle_clean',   column: 'chk_vehicle_clean',   label: 'Vehicle clean',   hint: 'Inside the van or the box: clean, dry, no smell, nothing else carried with the food.' },
  { key: 'handler_hygiene', column: 'chk_handler_hygiene', label: 'Handler hygiene', hint: 'The person carrying it in: clean hands and clothing, no open wounds, not visibly unwell.' },
  { key: 'documents',       column: 'chk_documents',       label: 'Paperwork',       hint: 'Bill, the supplier\'s own FSSAI number, and lot or batch details where they apply.' },
] as const;

const VEHICLE_TYPES: readonly { key: string; label: string }[] = [
  { key: '',             label: 'Not recorded' },
  { key: 'ambient',      label: 'Ordinary van' },
  { key: 'insulated',    label: 'Insulated box' },
  { key: 'refrigerated', label: 'Refrigerated' },
] as const;

const CHECK_SELECT = `
  SELECT c.*, IFNULL(d.name,'') AS department_name, IFNULL(s.name,'') AS store_name,
         IFNULL(v.name,'') AS vendor_name_now,
         IFNULL(g.status,'') AS grn_status_now
    FROM fssai_receiving_checks c
    LEFT JOIN departments d ON d.id = c.department_id
    LEFT JOIN store_locations s ON s.id = c.store_id
    LEFT JOIN vendors v ON v.id = c.vendor_id
    LEFT JOIN goods_receipt_notes g ON g.id = c.grn_id`;

function shapeCheck(row: any, photoCount = 0) {
  const vehicleTemp = fssaiNum(row.vehicle_temp_c);
  return {
    id: String(row.id),
    check_no: String(row.check_no || ''),
    business_date: String(row.business_date || ''),
    received_at: String(row.received_at || ''),
    shift: String(row.shift || ''),
    grn_id: String(row.grn_id || ''),
    grn_number: String(row.grn_number || ''),
    /* The GRN's status NOW, beside the number frozen on the inspection. A voided
     * GRN must not make the inspection disappear — `grn_id` has no FK precisely so
     * the inspection survives — but a reader has to be told. */
    grn_status_now: String(row.grn_status_now || ''),
    grn_voided_since: String(row.grn_status_now || '') === 'void' || String(row.grn_status_now || '') === 'voided',
    po_id: String(row.po_id || ''),
    vendor_id: String(row.vendor_id || ''),
    vendor_name: String(row.vendor_name || ''),
    vendor_name_now: String(row.vendor_name_now || ''),
    supplier_licence_no: String(row.supplier_licence_no || ''),
    supplier_licence_expiry: String(row.supplier_licence_expiry || ''),
    /* Derived on EVERY read, never stored: a stored "expired" goes stale at
     * midnight and a licence rendering "valid" the day after it lapsed is the worst
     * row this module could print. */
    supplier_licence_state: isISODate(String(row.supplier_licence_expiry || ''))
      ? (String(row.supplier_licence_expiry) < fssaiToday() ? 'expired' : 'valid')
      : 'unknown',
    invoice_number: String(row.invoice_number || ''),
    department_id: String(row.department_id || ''),
    department_name: String(row.department_name || ''),
    store_id: String(row.store_id || ''),
    store_name: String(row.store_name || ''),
    run_id: String(row.run_id || ''),
    vehicle_no: String(row.vehicle_no || ''),
    vehicle_type: String(row.vehicle_type || ''),
    vehicle_type_label: VEHICLE_TYPES.find((t) => t.key === String(row.vehicle_type || ''))?.label || '',
    chk_vehicle_clean: String(row.chk_vehicle_clean || ''),
    chk_handler_hygiene: String(row.chk_handler_hygiene || ''),
    chk_documents: String(row.chk_documents || ''),
    vehicle_temp_c: vehicleTemp,
    display_vehicle_temp: fssaiDisplayReading(vehicleTemp, 1),
    status: String(row.status || 'draft'),
    status_label: fssaiRecordStatusMeta(row.status).label,
    is_editable: fssaiRecordIsEditable(row.status),
    outcome: String(row.outcome || ''),
    line_count: Number(row.line_count) || 0,
    fail_count: Number(row.fail_count) || 0,
    rejected_count: Number(row.rejected_count) || 0,
    remarks: String(row.remarks || ''),
    checked_by: String(row.checked_by || ''),
    checked_name: String(row.checked_name || ''),
    submitted_at: String(row.submitted_at || ''),
    verified_by: String(row.verified_by || ''),
    verified_at: String(row.verified_at || ''),
    verify_note: String(row.verify_note || ''),
    voided_at: String(row.voided_at || ''),
    voided_by: String(row.voided_by || ''),
    void_reason: String(row.void_reason || ''),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || ''),
    photo_count: photoCount,
  };
}

const LINE_SELECT = `
  SELECT l.*, IFNULL(m.name,'') AS material_name_now,
         IFNULL(cc.ca_number,'') AS ca_number, IFNULL(cc.status,'') AS ca_status
    FROM fssai_receiving_lines l
    LEFT JOIN raw_materials m ON m.id = l.material_id
    LEFT JOIN fssai_corrective_actions cc ON cc.id = l.ca_id`;

function shapeLine(row: any, today: string, photoCount = 0) {
  const received = fssaiNum(row.qty_received);
  const accepted = fssaiNum(row.qty_accepted);
  const rejected = fssaiNum(row.qty_rejected);
  const temp = fssaiNum(row.temp_c);
  const checkpoints = FSSAI_RECEIVING_CHECKPOINTS.map((cp) => ({
    key: cp.key,
    column: cp.column,
    label: cp.label,
    hint: cp.hint,
    cold_only: !!cp.cold_only,
    value: String(row[cp.column] || ''),
    value_label: fssaiCheckResultLabel(row[cp.column]),
    is_fail: fssaiCheckResultIsFail(row[cp.column]),
    answered: fssaiCheckResultAnswered(row[cp.column]),
  }));
  const expiry = String(row.expiry_date || '');
  return {
    id: String(row.id),
    check_id: String(row.check_id),
    grn_item_id: String(row.grn_item_id || ''),
    material_id: String(row.material_id || ''),
    /* The frozen name leads. `material_name_now` is beside it because
     * `api/import-materials` HARD-DELETES and re-creates items, so the live row may
     * be gone entirely — and the sheet must still name what was checked. */
    material_name: String(row.material_name || ''),
    material_name_now: String(row.material_name_now || ''),
    material_missing_now: !String(row.material_name_now || '') && !!String(row.material_id || ''),
    brand: String(row.brand || ''),
    lot_no: String(row.lot_no || ''),
    /* ⚠️ QUANTITIES ARE IN THE PURCHASE UNIT the screen led with (the owner's rule
     * across 293 sites). `pack_size` and `recipe_uom` travel with them, frozen, so
     * nothing has to join raw_materials to render the second figure — and a pack
     * size changed next month cannot restate a delivery already inspected. */
    qty_received: received,
    qty_accepted: accepted,
    qty_rejected: rejected,
    uom: String(row.uom || ''),
    pack_size: fssaiNum(row.pack_size),
    recipe_uom: String(row.recipe_uom || ''),
    /* The recipe-unit figure, computed from the FROZEN pack size. null when either
     * half is missing — never 0, which would read as "none arrived". */
    qty_accepted_recipe: accepted !== null && fssaiNum(row.pack_size) !== null
      ? Number((accepted * (fssaiNum(row.pack_size) as number)).toFixed(4)) : null,
    mfg_date: String(row.mfg_date || ''),
    expiry_date: expiry,
    expiry_state: fssaiExpiryState(expiry, today, FSSAI_NEAR_EXPIRY_DAYS),
    expiry_state_label: fssaiExpiryStateMeta(fssaiExpiryState(expiry, today, FSSAI_NEAR_EXPIRY_DAYS)).label,
    shelf_life_days: fssaiInt(row.shelf_life_days),
    temp_c: temp,
    display_temp: fssaiDisplayReading(temp, 1),
    temp_min_used: fssaiNum(row.temp_min_used),
    temp_max_used: fssaiNum(row.temp_max_used),
    checkpoints,
    decision: String(row.decision || ''),
    decision_label: fssaiReceivingDecisionMeta(row.decision).label,
    /* What the QUANTITIES imply, beside what the checker DECIDED. They can
     * legitimately differ — a line may be rejected outright on quality with
     * nothing sent back yet — so this is shown as a prompt and never as the truth. */
    decision_implied: fssaiReceivingDecisionFor(received, accepted),
    reject_reason: String(row.reject_reason || ''),
    reject_reason_label: FSSAI_REJECT_REASONS.find((r) => r.key === String(row.reject_reason))?.label || '',
    reject_note: String(row.reject_note || ''),
    is_fail: Number(row.is_fail) ? 1 : 0,
    ca_id: String(row.ca_id || ''),
    ca_number: String(row.ca_number || ''),
    ca_status: String(row.ca_status || ''),
    note: String(row.note || ''),
    sort_order: Number(row.sort_order) || 0,
    photo_count: photoCount,
  };
}

/* `lineFails` and `lineGaps` are the shared predicates, imported above from
 * `../_p4/lib` under those names. They live there and not here for one reason: they
 * are the only pieces of this route a throwaway probe can call directly, and a
 * verdict rule that cannot be exercised is a verdict rule nobody has checked. */

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;
  const mgmt = isManagement(me);
  const today = fssaiToday();

  try {
    const db = getDb();
    const url = new URL(request.url);

    /* ══ ONE PHOTOGRAPH ═════════════════════════════════════════════════════ */
    const photoId = str(url.searchParams.get('photo_id'));
    if (photoId) {
      const p = db.prepare(
        `SELECT id, data_uri, mime, caption, size_bytes, image_dropped_at, entity_table
           FROM fssai_attachments
          WHERE id = ? AND entity_table IN ('fssai_receiving_checks','fssai_receiving_lines')`,
      ).get(photoId) as any;
      if (!p) return Response.json({ error: 'That photograph is no longer in the file.' }, { status: 404 });
      /* A delivery inspection is restaurant-wide by nature — it is the goods coming
       * in the back door, not one department's round — so any signed-in user may
       * see the photographs, exactly as any signed-in user may see the GRN they
       * came from. The gate that matters on this record is who may WRITE. */
      return Response.json({
        id: String(p.id), data_uri: String(p.data_uri || ''), mime: String(p.mime || ''),
        caption: String(p.caption || ''), size_bytes: Number(p.size_bytes) || 0,
        image_dropped_at: String(p.image_dropped_at || ''),
      });
    }

    /* ══ PREFILL FROM A GOODS RECEIPT — the "do not type it twice" path ══════ */
    if (url.searchParams.get('prefill') === '1') {
      const grnId = str(url.searchParams.get('grn_id'));
      if (!grnId) return Response.json({ error: 'Which delivery? No goods-receipt id was sent.' }, { status: 400 });
      const grn = db.prepare(
        `SELECT g.id, g.grn_number, g.date, g.time, g.po_id, g.vendor_id, g.vendor,
                g.invoice_number, g.invoice_date, g.received_by, g.status,
                IFNULL(v.name,'') AS vendor_name_now, IFNULL(v.gstin,'') AS vendor_gstin
           FROM goods_receipt_notes g
           LEFT JOIN vendors v ON v.id = g.vendor_id
          WHERE g.id = ?`,
      ).get(grnId) as any;
      if (!grn) return Response.json({ error: 'That delivery is not in the goods-receipt register.' }, { status: 404 });

      const existing = db.prepare(
        `SELECT id, check_no, status FROM fssai_receiving_checks WHERE grn_id = ? AND status <> 'void'
          ORDER BY created_at DESC LIMIT 1`,
      ).get(grnId) as any;

      const items = db.prepare(
        `SELECT i.id, i.material_id, i.quantity_received, i.quantity_accepted, i.quantity_rejected,
                i.rejection_reason, i.brand, i.notes,
                IFNULL(m.name,'')          AS material_name,
                IFNULL(m.purchase_unit,'') AS purchase_unit,
                IFNULL(m.unit,'')          AS unit,
                IFNULL(m.recipe_unit,'')   AS recipe_unit,
                m.pack_size, m.shelf_life_days, IFNULL(m.storage_location,'') AS storage_location
           FROM goods_receipt_note_items i
           LEFT JOIN raw_materials m ON m.id = i.material_id
          WHERE i.grn_id = ?
          ORDER BY i.rowid ASC`,
      ).all(grnId) as any[];

      return Response.json({
        grn: {
          id: String(grn.id), grn_number: String(grn.grn_number || ''),
          date: String(grn.date || ''), time: String(grn.time || ''),
          po_id: String(grn.po_id || ''), vendor_id: String(grn.vendor_id || ''),
          /* `g.vendor` is the name frozen on the GRN; `vendor_name_now` is the live
           * one. Lead with the frozen one for the same reason the record does. */
          vendor_name: String(grn.vendor || grn.vendor_name_now || ''),
          vendor_gstin: String(grn.vendor_gstin || ''),
          invoice_number: String(grn.invoice_number || ''),
          invoice_date: String(grn.invoice_date || ''),
          received_by: String(grn.received_by || ''),
          status: String(grn.status || ''),
        },
        /* ⚠️ ALREADY INSPECTED? Said plainly rather than silently creating a second
         * record. Two inspections of one delivery is how a file stops making
         * sense, and the honest answer is a link to the first one. */
        existing: existing
          ? { id: String(existing.id), check_no: String(existing.check_no || ''), status: String(existing.status || '') }
          : null,
        lines: items.map((i, n) => ({
          grn_item_id: String(i.id),
          material_id: String(i.material_id || ''),
          material_name: String(i.material_name || ''),
          brand: String(i.brand || ''),
          qty_received: fssaiNum(i.quantity_received),
          qty_accepted: fssaiNum(i.quantity_accepted),
          qty_rejected: fssaiNum(i.quantity_rejected),
          /* PURCHASE UNIT LEADS (owner's rule). `purchase_unit` first, `unit` as
           * the fallback — a material with no purchase unit set is stored and
           * bought in `unit`. */
          uom: String(i.purchase_unit || i.unit || ''),
          pack_size: fssaiNum(i.pack_size),
          recipe_uom: String(i.recipe_unit || ''),
          /* The item's configured shelf life, so the form can propose an expiry
           * date from a manufacture date. MEASURED: all 952 items have this blank
           * today, so it will almost always be null — which is P5's gap, not a bug
           * here, and the form must cope with it rather than demanding it. */
          shelf_life_days: fssaiInt(i.shelf_life_days),
          storage_location: String(i.storage_location || ''),
          grn_rejection_reason: String(i.rejection_reason || ''),
          sort_order: n,
        })),
        note: items.length
          ? 'These are the lines already recorded on the goods receipt. Checking them here does not change any quantity on the delivery or in stock — this record says whether what arrived was fit, and the goods receipt stays the place the quantity lives.'
          : 'That delivery has no lines recorded on it yet.',
      });
    }

    /* ══ DELIVERIES WITH NO INSPECTION YET ══════════════════════════════════ */
    if (url.searchParams.get('open_grns') === '1') {
      const since = isISODate(str(url.searchParams.get('since')))
        ? str(url.searchParams.get('since'))
        : addDaysISO(today, -14);
      const rows = db.prepare(
        `SELECT g.id, g.grn_number, g.date, g.time, g.vendor_id, g.vendor, g.invoice_number,
                g.status, g.qc_outcome,
                (SELECT COUNT(*) FROM goods_receipt_note_items i WHERE i.grn_id = g.id) AS line_count
           FROM goods_receipt_notes g
          WHERE IFNULL(g.date,'') >= ?
            AND IFNULL(g.voided_at,'') = ''
            AND NOT EXISTS (
              SELECT 1 FROM fssai_receiving_checks c
               WHERE c.grn_id = g.id AND c.status <> 'void'
            )
          ORDER BY g.date DESC, g.rowid DESC
          LIMIT 100`,
      ).all(since) as any[];
      return Response.json({
        since,
        grns: rows.map((r) => ({
          id: String(r.id), grn_number: String(r.grn_number || ''), date: String(r.date || ''),
          time: String(r.time || ''), vendor_id: String(r.vendor_id || ''),
          vendor_name: String(r.vendor || ''), invoice_number: String(r.invoice_number || ''),
          status: String(r.status || ''), qc_outcome: String(r.qc_outcome || ''),
          line_count: Number(r.line_count) || 0,
        })),
      });
    }

    /* ══ ONE INSPECTION ═════════════════════════════════════════════════════ */
    const id = str(url.searchParams.get('id'));
    if (id) {
      const row = db.prepare(`${CHECK_SELECT} WHERE c.id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That inspection is no longer in the file.' }, { status: 404 });
      const lineRows = db.prepare(`${LINE_SELECT} WHERE l.check_id = ? ORDER BY l.sort_order ASC, l.rowid ASC`).all(id) as any[];
      const linePhotos = fssaiAttachmentCounts(db, 'fssai_receiving_lines', lineRows.map((l) => String(l.id)));
      const headerPhotos = db.prepare(
        `SELECT id, kind, mime, size_bytes, caption, filename, created_by, created_at,
                (data_uri <> '') AS has_image
           FROM fssai_attachments
          WHERE entity_table = 'fssai_receiving_checks' AND entity_id = ?
          ORDER BY created_at ASC`,
      ).all(id) as any[];

      const lines = lineRows.map((l) => shapeLine(l, today, linePhotos.get(String(l.id)) || 0));
      /* The draft's live preview of what the verdict WOULD be, computed with the
       * same predicate the submit freeze uses. Never written anywhere. */
      const preview = lineRows.map(lineFails);
      const gaps = lineRows.map((l, n) => ({ line_id: String(l.id), name: lines[n].material_name, missing: lineGaps(l) }))
        .filter((x) => x.missing.length);

      return Response.json({
        check: shapeCheck(row, headerPhotos.length),
        lines,
        photos: headerPhotos.map((p) => ({
          id: String(p.id), kind: String(p.kind || 'photo'), mime: String(p.mime || ''),
          size_bytes: Number(p.size_bytes) || 0, caption: String(p.caption || ''),
          filename: String(p.filename || ''), created_by: String(p.created_by || ''),
          created_at: String(p.created_at || ''), has_image: Number(p.has_image) ? 1 : 0,
        })),
        preview: {
          fail_count: preview.filter((p) => p.fail).length,
          would_fail: preview.map((p, n) => ({ line_id: String(lineRows[n].id), fail: p.fail, why: p.why })),
          incomplete: gaps,
        },
        can_submit: fssaiRecordIsEditable(row.status) && lineRows.length > 0,
        can_verify: canVerifyFssai(me, row.checked_by) && String(row.status) === 'submitted',
        void_refusal: fssaiVoidRefusal(me, { status: row.status, voided_at: row.voided_at }, 'placeholder reason'),
        vocab: {
          checkpoints: FSSAI_RECEIVING_CHECKPOINTS,
          vehicle_checkpoints: VEHICLE_CHECKPOINTS,
          vehicle_types: VEHICLE_TYPES,
          results: FSSAI_CHECK_RESULTS,
          decisions: FSSAI_RECEIVING_DECISIONS,
          reject_reasons: FSSAI_REJECT_REASONS,
          shifts: FSSAI_SHIFTS,
          uoms: FSSAI_TEMP_UOMS,
        },
        /* The sentence that keeps HARD RULE 5 visible on the one screen most
         * likely to be mistaken for a stock screen. */
        no_stock_movement: 'Accepting or rejecting a line here records what you found. It does not change any quantity on the goods receipt or in stock — that stays with the delivery.',
        today,
      });
    }

    /* ══ THE LIST ═══════════════════════════════════════════════════════════ */
    const where: string[] = [];
    const args: any[] = [];

    const from = str(url.searchParams.get('from'));
    const to = str(url.searchParams.get('to'));
    if (from) {
      if (!isISODate(from)) return Response.json({ error: 'That "from" date is not a real date.' }, { status: 400 });
      where.push('c.business_date >= ?'); args.push(from);
    }
    if (to) {
      if (!isISODate(to)) return Response.json({ error: 'That "to" date is not a real date.' }, { status: 400 });
      where.push('c.business_date <= ?'); args.push(to);
    }
    const vendorId = str(url.searchParams.get('vendor_id'));
    if (vendorId) { where.push('c.vendor_id = ?'); args.push(vendorId); }

    const status = str(url.searchParams.get('status')) || 'live';
    if (status === 'live') where.push(`c.status <> 'void'`);
    else if (status !== 'all') {
      if (!FSSAI_RECORD_STATUSES.some((s) => s.key === status)) {
        return Response.json({ error: `"${status}" is not a state an inspection can be in.` }, { status: 400 });
      }
      where.push('c.status = ?'); args.push(status);
    }
    if (url.searchParams.get('fails') === '1') where.push(`(c.fail_count > 0 OR c.outcome = 'fail')`);

    const vis = fssaiRecordVisibility(me, { department: 'c.department_id', recordedBy: 'c.checked_by' }, mgmt, FSSAI_NO_MATCH);
    if (vis.sql) { where.push(vis.sql); args.push(...vis.args); }

    const rows = db.prepare(
      `${CHECK_SELECT}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY c.business_date DESC, c.received_at DESC, c.created_at DESC, c.rowid DESC
       LIMIT ${LIST_LIMIT}`,
    ).all(...args) as any[];

    const photoCounts = fssaiAttachmentCounts(db, 'fssai_receiving_checks', rows.map((r) => String(r.id)));
    const q = str(url.searchParams.get('q')).toLowerCase();
    const shaped = rows
      .map((r) => shapeCheck(r, photoCounts.get(String(r.id)) || 0))
      .filter((r) => !q
        || r.check_no.toLowerCase().includes(q)
        || r.vendor_name.toLowerCase().includes(q)
        || r.grn_number.toLowerCase().includes(q)
        || r.invoice_number.toLowerCase().includes(q)
        || r.vehicle_no.toLowerCase().includes(q)
        || r.checked_by.toLowerCase().includes(q));

    const counts = db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS drafts,
              SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS submitted,
              SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified,
              SUM(CASE WHEN status = 'void' THEN 1 ELSE 0 END) AS voided,
              SUM(CASE WHEN status <> 'void' AND (fail_count > 0 OR outcome = 'fail') THEN 1 ELSE 0 END) AS failed
         FROM fssai_receiving_checks
        WHERE business_date >= ? AND business_date <= ?`,
    ).get(from || '0000-01-01', to || '9999-12-31') as any;

    return Response.json({
      checks: shaped,
      counts: {
        total: Number(counts?.total) || 0,
        drafts: Number(counts?.drafts) || 0,
        submitted: Number(counts?.submitted) || 0,
        verified: Number(counts?.verified) || 0,
        voided: Number(counts?.voided) || 0,
        failed: Number(counts?.failed) || 0,
      },
      vocab: {
        statuses: FSSAI_RECORD_STATUSES,
        decisions: FSSAI_RECEIVING_DECISIONS,
        reject_reasons: FSSAI_REJECT_REASONS,
        shifts: FSSAI_SHIFTS,
      },
      is_management: mgmt,
      me: me.email || '',
      today,
      earliest_backdate: addDaysISO(today, -FSSAI_BACKDATE_DAYS),
      truncated: rows.length >= LIST_LIMIT,
    });
  } catch (e: any) {
    console.error('GET /api/fssai/receiving failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the delivery inspections' }, { status: 500 });
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
    const action = str(body?.action) || 'create';
    const today = fssaiToday();

    /** The inspection and whether this person may change it. One place. */
    const loadCheck = (id: string) => db.prepare(`SELECT * FROM fssai_receiving_checks WHERE id = ?`).get(id) as any;

    /**
     * MAY THIS PERSON EDIT THIS DRAFT?
     *
     * The checker, or management. Not "anybody signed in": a draft is somebody's
     * half-finished inspection of a delivery they stood in front of, and a
     * colleague overwriting its tick-boxes would put their judgement under
     * another person's name on a compliance record.
     */
    const editRefusal = (row: any): string => {
      if (!fssaiRecordIsEditable(row.status)) {
        return String(row.status) === 'void'
          ? 'That inspection has been voided, so it cannot be changed.'
          : 'That inspection has been submitted, so it cannot be changed. If it was wrong, a manager can void it with a reason and a fresh one can be taken — the file then shows both.';
      }
      const mine = String(me.email || '').trim().toLowerCase() === String(row.checked_by || '').trim().toLowerCase();
      if (!mine && !isManagement(me)) {
        return `This inspection is being filled in by ${String(row.checked_name || row.checked_by || 'somebody else')}. Only they or a manager can change it.`;
      }
      return '';
    };

    /* ══════════════════════════════════════════════════════════════════════
     * CREATE — a draft, optionally prefilled from a goods receipt.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'create') {
      const businessDate = isISODate(str(body?.business_date)) ? str(body.business_date) : today;
      const daysBack = daysBetweenISO(businessDate, today);
      if (!Number.isFinite(daysBack) || daysBack < 0) {
        return Response.json({ error: 'An inspection cannot be dated in the future.', code: 'future_date' }, { status: 400 });
      }
      if (daysBack > FSSAI_BACKDATE_DAYS) {
        return Response.json(
          { error: `An inspection can be dated today or yesterday. ${businessDate} is ${daysBack} days back — the file should not claim somebody stood at the door on a day nobody did.`, code: 'too_old' },
          { status: 400 },
        );
      }
      const backdateReason = str(body?.backdate_reason).slice(0, 1000);
      if (daysBack > 0 && backdateReason.length < 4) {
        return Response.json({ error: 'Say why this inspection is being entered for an earlier day.', code: 'backdate_reason_required' }, { status: 400 });
      }

      const shift = str(body?.shift);
      if (!isFssaiShift(shift)) return Response.json({ error: `"${shift}" is not one of the shifts.` }, { status: 400 });

      const grnId = str(body?.grn_id);
      let grn: any = null;
      if (grnId) {
        grn = db.prepare(
          `SELECT id, grn_number, po_id, vendor_id, vendor, invoice_number, date, time
             FROM goods_receipt_notes WHERE id = ?`,
        ).get(grnId) as any;
        if (!grn) return Response.json({ error: 'That delivery is not in the goods-receipt register.' }, { status: 400 });
        /* ONE LIVE INSPECTION PER DELIVERY. Two of them is how a file stops making
         * sense, and the refusal hands back the id so the screen can offer "open
         * it" instead of a dead end — the pattern the run-open 409 already uses. */
        const dupe = db.prepare(
          `SELECT id, check_no, status FROM fssai_receiving_checks
            WHERE grn_id = ? AND status <> 'void' ORDER BY created_at DESC LIMIT 1`,
        ).get(grnId) as any;
        if (dupe) {
          return Response.json(
            {
              error: `Delivery ${String(grn.grn_number || '')} has already been inspected (${String(dupe.check_no || 'draft')}). Open that record rather than starting a second one.`,
              code: 'already_inspected', id: String(dupe.id), check_no: String(dupe.check_no || ''), status: String(dupe.status || ''),
            },
            { status: 409 },
          );
        }
      }

      const vendorId = str(body?.vendor_id) || String(grn?.vendor_id || '');
      let vendorName = str(body?.vendor_name) || String(grn?.vendor || '');
      if (vendorId && !vendorName) {
        const v = db.prepare(`SELECT name FROM vendors WHERE id = ?`).get(vendorId) as any;
        vendorName = String(v?.name || '');
      }
      if (!vendorId && !vendorName) {
        return Response.json(
          { error: 'Say who delivered it. A delivery inspection with no supplier on it cannot be used for anything later.', code: 'vendor_required' },
          { status: 400 },
        );
      }

      const licenceExpiry = str(body?.supplier_licence_expiry);
      if (licenceExpiry && !isISODate(licenceExpiry)) {
        return Response.json({ error: 'That licence expiry date is not a real date.' }, { status: 400 });
      }

      const id = generateId();
      /* THE NUMBER IS ALLOCATED AT SUBMIT, NOT HERE, and that is deliberate: a
       * draft abandoned at the door would otherwise burn an RQC number and leave a
       * gap in the series, which is the first thing an inspector counts. */
      const lineSeeds: any[] = Array.isArray(body?.lines) ? body.lines : [];

      const tx = db.transaction(() => {
        db.prepare(
          `INSERT INTO fssai_receiving_checks
             (id, check_no, business_date, received_at, shift, grn_id, grn_number, po_id,
              vendor_id, vendor_name, supplier_licence_no, supplier_licence_expiry,
              invoice_number, department_id, store_id, run_id,
              vehicle_no, vehicle_type, chk_vehicle_clean, chk_handler_hygiene, chk_documents,
              vehicle_temp_c, status, outcome, line_count, fail_count, rejected_count,
              remarks, checked_by, checked_name, created_by, outlet_id)
           VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '',
                   ?, ?, '', '', '', ?, 'draft', '', 0, 0, 0, ?, ?, ?, ?, ?)`,
        ).run(
          id, businessDate, fssaiClock(body?.received_at) || String(grn?.time || ''), shift,
          grnId, String(grn?.grn_number || ''), str(body?.po_id) || String(grn?.po_id || ''),
          vendorId, vendorName,
          str(body?.supplier_licence_no).slice(0, 60), licenceExpiry,
          str(body?.invoice_number).slice(0, 120) || String(grn?.invoice_number || ''),
          str(body?.department_id), str(body?.store_id),
          str(body?.vehicle_no).slice(0, 60),
          VEHICLE_TYPES.some((t) => t.key === str(body?.vehicle_type)) ? str(body?.vehicle_type) : '',
          fssaiNum(body?.vehicle_temp_c),
          str(body?.remarks).slice(0, 4000),
          me.email || '', me.name || '', me.email || '', outletId,
        );

        let n = 0;
        for (const seed of lineSeeds) {
          const name = str(seed?.material_name).slice(0, 200);
          if (!name && !str(seed?.material_id)) continue;
          db.prepare(
            `INSERT INTO fssai_receiving_lines
               (id, check_id, grn_item_id, material_id, material_name, brand, lot_no,
                qty_received, qty_accepted, qty_rejected, uom, pack_size, recipe_uom,
                mfg_date, expiry_date, shelf_life_days, temp_c, temp_min_used, temp_max_used,
                chk_quality, chk_temperature, chk_expiry, chk_damage, chk_weight,
                chk_invoice_match, chk_label, decision, reject_reason, reject_note,
                is_fail, ca_id, note, sort_order, outlet_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, NULL, NULL, NULL,
                     '', '', '', '', '', '', '', '', '', '', 0, '', '', ?, ?)`,
          ).run(
            generateId(), id, str(seed?.grn_item_id), str(seed?.material_id), name,
            str(seed?.brand).slice(0, 120), str(seed?.lot_no).slice(0, 120),
            fssaiNum(seed?.qty_received), fssaiNum(seed?.qty_accepted), fssaiNum(seed?.qty_rejected),
            str(seed?.uom).slice(0, 40), fssaiNum(seed?.pack_size), str(seed?.recipe_uom).slice(0, 40),
            isISODate(str(seed?.expiry_date)) ? str(seed.expiry_date) : '',
            fssaiInt(seed?.shelf_life_days),
            n, outletId,
          );
          n += 1;
        }
        db.prepare(`UPDATE fssai_receiving_checks SET line_count=? WHERE id=?`).run(n, id);

        fssaiAuditBestEffort(db, {
          entity_table: 'fssai_receiving_checks', entity_id: id, action: 'create',
          after: { business_date: businessDate, grn_id: grnId, grn_number: String(grn?.grn_number || ''), vendor_name: vendorName, line_count: n },
          reason: daysBack > 0 ? `Entered for ${businessDate}. Reason given: ${backdateReason}` : 'Inspection started',
          actor: { email: me.email, name: me.name }, outlet_id: outletId,
        });
      });
      tx();

      const row = db.prepare(`${CHECK_SELECT} WHERE c.id = ?`).get(id) as any;
      const lineRows = db.prepare(`${LINE_SELECT} WHERE l.check_id = ? ORDER BY l.sort_order ASC`).all(id) as any[];
      return Response.json({
        ok: true,
        check: shapeCheck(row),
        lines: lineRows.map((l) => shapeLine(l, today)),
        note: 'Draft started. Nothing is in the file until you submit it, and the inspection number is given then — so an inspection abandoned at the door does not leave a gap in the series.',
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * SAVE_HEADER — the van, the driver, the paperwork, the remarks.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'save_header') {
      const id = str(body?.id);
      if (!id) return Response.json({ error: 'Which inspection? No id was sent.' }, { status: 400 });
      const row = loadCheck(id);
      if (!row) return Response.json({ error: 'That inspection is no longer in the file.' }, { status: 404 });
      const refusal = editRefusal(row);
      if (refusal) return Response.json({ error: refusal, code: 'not_editable' }, { status: fssaiRecordIsEditable(row.status) ? 403 : 409 });

      /* Every tick-box is validated against the shared vocabulary. There is no
       * CHECK constraint on these columns (db.ts adds none), so this is the WHOLE
       * enforcement — a value the vocabulary does not declare would be stored and
       * would then render as itself on a food-safety record. */
      const ticks: Record<string, string> = {};
      for (const cp of VEHICLE_CHECKPOINTS) {
        const v = body?.[cp.column] !== undefined ? str(body[cp.column]) : String(row[cp.column] || '');
        if (!isFssaiCheckResult(v)) {
          return Response.json({ error: `"${v}" is not an answer to "${cp.label}". Use in order, not in order, or not applicable.` }, { status: 400 });
        }
        ticks[cp.column] = v;
      }

      const shift = body?.shift !== undefined ? str(body.shift) : String(row.shift || '');
      if (!isFssaiShift(shift)) return Response.json({ error: `"${shift}" is not one of the shifts.` }, { status: 400 });

      const licenceExpiry = body?.supplier_licence_expiry !== undefined
        ? str(body.supplier_licence_expiry) : String(row.supplier_licence_expiry || '');
      if (licenceExpiry && !isISODate(licenceExpiry)) {
        return Response.json({ error: 'That licence expiry date is not a real date.' }, { status: 400 });
      }
      const vehicleType = body?.vehicle_type !== undefined ? str(body.vehicle_type) : String(row.vehicle_type || '');
      if (vehicleType && !VEHICLE_TYPES.some((t) => t.key === vehicleType)) {
        return Response.json({ error: `"${vehicleType}" is not a kind of vehicle this record knows.` }, { status: 400 });
      }

      const next = {
        received_at: body?.received_at !== undefined ? fssaiClock(body.received_at) : String(row.received_at || ''),
        shift,
        vehicle_no: (body?.vehicle_no !== undefined ? str(body.vehicle_no) : String(row.vehicle_no || '')).slice(0, 60),
        vehicle_type: vehicleType,
        vehicle_temp_c: body?.vehicle_temp_c !== undefined ? fssaiNum(body.vehicle_temp_c) : fssaiNum(row.vehicle_temp_c),
        supplier_licence_no: (body?.supplier_licence_no !== undefined ? str(body.supplier_licence_no) : String(row.supplier_licence_no || '')).slice(0, 60),
        supplier_licence_expiry: licenceExpiry,
        invoice_number: (body?.invoice_number !== undefined ? str(body.invoice_number) : String(row.invoice_number || '')).slice(0, 120),
        department_id: body?.department_id !== undefined ? str(body.department_id) : String(row.department_id || ''),
        store_id: body?.store_id !== undefined ? str(body.store_id) : String(row.store_id || ''),
        remarks: (body?.remarks !== undefined ? str(body.remarks) : String(row.remarks || '')).slice(0, 4000),
        /* Named explicitly rather than spread from `ticks`. A `Record<string,string>`
         * spread adds no known keys to the object's type, so `next.chk_documents`
         * below would not compile — and `npx tsc --noEmit` is THE type gate here
         * (next.config sets ignoreBuildErrors, so a build passing proves nothing). */
        chk_vehicle_clean: ticks.chk_vehicle_clean,
        chk_handler_hygiene: ticks.chk_handler_hygiene,
        chk_documents: ticks.chk_documents,
      };

      const tx = db.transaction(() => {
        db.prepare(
          `UPDATE fssai_receiving_checks
              SET received_at=?, shift=?, vehicle_no=?, vehicle_type=?, vehicle_temp_c=?,
                  supplier_licence_no=?, supplier_licence_expiry=?, invoice_number=?,
                  department_id=?, store_id=?, remarks=?,
                  chk_vehicle_clean=?, chk_handler_hygiene=?, chk_documents=?,
                  updated_at=datetime('now')
            WHERE id=? AND status='draft'`,
        ).run(
          next.received_at, next.shift, next.vehicle_no, next.vehicle_type, next.vehicle_temp_c,
          next.supplier_licence_no, next.supplier_licence_expiry, next.invoice_number,
          next.department_id, next.store_id, next.remarks,
          next.chk_vehicle_clean, next.chk_handler_hygiene, next.chk_documents, id,
        );
      });
      tx();

      const out = db.prepare(`${CHECK_SELECT} WHERE c.id = ?`).get(id) as any;
      const shaped = shapeCheck(out);
      return Response.json({
        ok: true,
        check: shaped,
        /* A LAPSED SUPPLIER LICENCE IS SAID, NOT HIDDEN — and it is said as a
         * warning rather than as a refusal, because the goods are already at the
         * door and the honest record is "it arrived and the licence had lapsed". */
        warning: shaped.supplier_licence_state === 'expired'
          ? `The supplier's licence expired on ${shaped.supplier_licence_expiry}. Accepting goods from a supplier whose licence has lapsed is the finding an inspector writes up first — record what you did about it in the remarks.`
          : '',
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * SAVE_LINE — add or change one line on a draft.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'save_line') {
      const checkId = str(body?.check_id);
      if (!checkId) return Response.json({ error: 'Which inspection? No id was sent.' }, { status: 400 });
      const row = loadCheck(checkId);
      if (!row) return Response.json({ error: 'That inspection is no longer in the file.' }, { status: 404 });
      const refusal = editRefusal(row);
      if (refusal) return Response.json({ error: refusal, code: 'not_editable' }, { status: fssaiRecordIsEditable(row.status) ? 403 : 409 });

      const lineId = str(body?.line_id);
      const existing = lineId
        ? db.prepare(`SELECT * FROM fssai_receiving_lines WHERE id = ? AND check_id = ?`).get(lineId, checkId) as any
        : null;
      if (lineId && !existing) return Response.json({ error: 'That line is no longer on this inspection.' }, { status: 404 });

      const materialId = body?.material_id !== undefined ? str(body.material_id) : String(existing?.material_id || '');
      let materialName = (body?.material_name !== undefined ? str(body.material_name) : String(existing?.material_name || '')).slice(0, 200);
      let packSize = body?.pack_size !== undefined ? fssaiNum(body.pack_size) : fssaiNum(existing?.pack_size);
      let uom = (body?.uom !== undefined ? str(body.uom) : String(existing?.uom || '')).slice(0, 40);
      let recipeUom = (body?.recipe_uom !== undefined ? str(body.recipe_uom) : String(existing?.recipe_uom || '')).slice(0, 40);

      if (materialId) {
        const mat = db.prepare(
          `SELECT id, name, purchase_unit, unit, recipe_unit, pack_size FROM raw_materials WHERE id = ?`,
        ).get(materialId) as any;
        if (!mat) return Response.json({ error: 'That item is not in the item list.' }, { status: 400 });
        materialName = materialName || String(mat.name || '');
        /* PURCHASE UNIT LEADS and the pack size is FROZEN onto the line now, so a
         * pack size changed next month cannot restate a delivery already inspected
         * (the LPP mixed-basis trap, avoided by freezing rather than by joining). */
        uom = uom || String(mat.purchase_unit || mat.unit || '');
        recipeUom = recipeUom || String(mat.recipe_unit || '');
        if (packSize === null) packSize = fssaiNum(mat.pack_size);
      }
      if (!materialName) {
        return Response.json({ error: 'Name what this line is. A line with no item on it cannot be read later.' }, { status: 400 });
      }

      /* Every one of the seven line checkpoints, validated against the shared
       * vocabulary — see the identical note on save_header. */
      const ticks: Record<string, string> = {};
      for (const cp of FSSAI_RECEIVING_CHECKPOINTS) {
        const v = body?.[cp.column] !== undefined ? str(body[cp.column]) : String(existing?.[cp.column] || '');
        if (!isFssaiCheckResult(v)) {
          return Response.json({ error: `"${v}" is not an answer to "${cp.label}". Use in order, not in order, or not applicable.` }, { status: 400 });
        }
        ticks[cp.column] = v;
      }

      const received = body?.qty_received !== undefined ? fssaiNum(body.qty_received) : fssaiNum(existing?.qty_received);
      const accepted = body?.qty_accepted !== undefined ? fssaiNum(body.qty_accepted) : fssaiNum(existing?.qty_accepted);
      let rejected = body?.qty_rejected !== undefined ? fssaiNum(body.qty_rejected) : fssaiNum(existing?.qty_rejected);

      if (received !== null && received < 0) return Response.json({ error: 'A received quantity cannot be negative.' }, { status: 400 });
      if (accepted !== null && accepted < 0) return Response.json({ error: 'An accepted quantity cannot be negative.' }, { status: 400 });
      if (rejected !== null && rejected < 0) return Response.json({ error: 'A rejected quantity cannot be negative.' }, { status: 400 });
      if (received !== null && accepted !== null && accepted > received) {
        return Response.json(
          { error: `You cannot accept ${accepted} ${uom} of a delivery of ${received} ${uom}.`.replace(/ {2,}/g, ' ') },
          { status: 400 },
        );
      }
      /* THE REJECTED QUANTITY IS DERIVED WHEN THE CALLER DID NOT SEND ONE, and it
       * is NOT forced when they did: a line can be short-delivered (received 8 of
       * 10) and separately have 2 rejected, so received − accepted is a sensible
       * default and a terrible assertion. */
      if (rejected === null && received !== null && accepted !== null) {
        rejected = Number((received - accepted).toFixed(4));
      }
      if (received !== null && accepted !== null && rejected !== null
        && Number((accepted + rejected).toFixed(4)) > Number(received.toFixed(4))) {
        return Response.json(
          { error: `Accepted and rejected add up to ${Number((accepted + rejected).toFixed(4))} ${uom}, more than the ${received} ${uom} that arrived.`.replace(/ {2,}/g, ' ') },
          { status: 400 },
        );
      }

      const decision = body?.decision !== undefined ? str(body.decision) : String(existing?.decision || '');
      if (decision && !FSSAI_RECEIVING_DECISIONS.some((d) => d.key === decision)) {
        return Response.json({ error: `"${decision}" is not a decision a line can carry.` }, { status: 400 });
      }
      const rejectReason = (body?.reject_reason !== undefined ? str(body.reject_reason) : String(existing?.reject_reason || ''));
      if (rejectReason && !FSSAI_REJECT_REASONS.some((r) => r.key === rejectReason)) {
        return Response.json({ error: `"${rejectReason}" is not one of the reasons on the list.` }, { status: 400 });
      }
      const rejectNote = (body?.reject_note !== undefined ? str(body.reject_note) : String(existing?.reject_note || '')).slice(0, 2000);
      /* ANYTHING SENT BACK NEEDS A CODED REASON. §18's reports ask "what do we
       * reject this vendor for", and free text cannot be grouped — which is why the
       * list is coded and why 'other' exists with its own note rather than forcing
       * a wrong code. */
      const sendingBack = (rejected !== null && rejected > 0) || decision === 'rejected' || decision === 'partially_accepted';
      if (sendingBack && !rejectReason) {
        return Response.json(
          { error: 'Pick a reason for sending it back. A rejection with no reason cannot be grouped, so nothing can ever be shown about this supplier.', code: 'reject_reason_required' },
          { status: 400 },
        );
      }
      if (rejectReason === 'other' && !rejectNote) {
        return Response.json(
          { error: 'You picked "Other" — say in words what was wrong with it.', code: 'reject_note_required' },
          { status: 400 },
        );
      }

      const expiryDate = body?.expiry_date !== undefined ? str(body.expiry_date) : String(existing?.expiry_date || '');
      if (expiryDate && !isISODate(expiryDate)) {
        return Response.json({ error: 'That expiry date is not a real date.' }, { status: 400 });
      }
      const mfgDate = body?.mfg_date !== undefined ? str(body.mfg_date) : String(existing?.mfg_date || '');
      if (mfgDate && !isISODate(mfgDate)) {
        return Response.json({ error: 'That manufacture date is not a real date.' }, { status: 400 });
      }
      if (mfgDate && expiryDate && expiryDate < mfgDate) {
        return Response.json({ error: `The pack cannot expire on ${expiryDate}, before it was made on ${mfgDate}.` }, { status: 400 });
      }

      /* ── THE TEMPERATURE RANGE, RESOLVED AND FROZEN ONTO THE LINE ─────────
       * Resolved exactly as a temperature reading is — the item's own rule first,
       * then the 'delivery' standard — and then frozen, so the record can say what
       * range was actually applied to that pack on that day. */
      const temp = body?.temp_c !== undefined ? fssaiNum(body.temp_c) : fssaiNum(existing?.temp_c);
      let tempMin = fssaiNum(existing?.temp_min_used);
      let tempMax = fssaiNum(existing?.temp_max_used);
      if (temp !== null && (tempMin === null && tempMax === null)) {
        const range = resolveFssaiRange(db, { logKind: 'delivery', materialId, uom: 'C' });
        tempMin = range.min;
        tempMax = range.max;
      }

      const shelfLife = body?.shelf_life_days !== undefined ? fssaiInt(body.shelf_life_days) : fssaiInt(existing?.shelf_life_days);
      const candidate = {
        ...ticks,
        qty_rejected: rejected, temp_c: temp, temp_min_used: tempMin, temp_max_used: tempMax,
        decision, uom,
      };
      /* `is_fail` IS COMPUTED NOW AND RE-COMPUTED AT SUBMIT from the stored row, so
       * a draft's badge and the frozen verdict come from one predicate. After
       * submit it is never touched again. */
      const verdict = lineFails(candidate);

      const id = lineId || generateId();
      const nextSort = lineId
        ? Number(existing.sort_order) || 0
        : Number((db.prepare(`SELECT IFNULL(MAX(sort_order),-1)+1 AS n FROM fssai_receiving_lines WHERE check_id=?`).get(checkId) as any)?.n) || 0;

      const tx = db.transaction(() => {
        if (lineId) {
          db.prepare(
            `UPDATE fssai_receiving_lines
                SET material_id=?, material_name=?, brand=?, lot_no=?,
                    qty_received=?, qty_accepted=?, qty_rejected=?, uom=?, pack_size=?, recipe_uom=?,
                    mfg_date=?, expiry_date=?, shelf_life_days=?,
                    temp_c=?, temp_min_used=?, temp_max_used=?,
                    chk_quality=?, chk_temperature=?, chk_expiry=?, chk_damage=?, chk_weight=?,
                    chk_invoice_match=?, chk_label=?,
                    decision=?, reject_reason=?, reject_note=?, is_fail=?, note=?,
                    updated_at=datetime('now')
              WHERE id=? AND check_id=?`,
          ).run(
            materialId, materialName, str(body?.brand ?? existing?.brand).slice(0, 120),
            str(body?.lot_no ?? existing?.lot_no).slice(0, 120),
            received, accepted, rejected, uom, packSize, recipeUom,
            mfgDate, expiryDate, shelfLife,
            temp, tempMin, tempMax,
            ticks.chk_quality, ticks.chk_temperature, ticks.chk_expiry, ticks.chk_damage,
            ticks.chk_weight, ticks.chk_invoice_match, ticks.chk_label,
            decision, rejectReason, rejectNote, verdict.fail ? 1 : 0,
            str(body?.note ?? existing?.note).slice(0, 2000),
            id, checkId,
          );
        } else {
          db.prepare(
            `INSERT INTO fssai_receiving_lines
               (id, check_id, grn_item_id, material_id, material_name, brand, lot_no,
                qty_received, qty_accepted, qty_rejected, uom, pack_size, recipe_uom,
                mfg_date, expiry_date, shelf_life_days, temp_c, temp_min_used, temp_max_used,
                chk_quality, chk_temperature, chk_expiry, chk_damage, chk_weight,
                chk_invoice_match, chk_label, decision, reject_reason, reject_note,
                is_fail, ca_id, note, sort_order, outlet_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
          ).run(
            id, checkId, str(body?.grn_item_id), materialId, materialName,
            str(body?.brand).slice(0, 120), str(body?.lot_no).slice(0, 120),
            received, accepted, rejected, uom, packSize, recipeUom,
            mfgDate, expiryDate, shelfLife, temp, tempMin, tempMax,
            ticks.chk_quality, ticks.chk_temperature, ticks.chk_expiry, ticks.chk_damage,
            ticks.chk_weight, ticks.chk_invoice_match, ticks.chk_label,
            decision, rejectReason, rejectNote, verdict.fail ? 1 : 0,
            str(body?.note).slice(0, 2000), nextSort, outletId,
          );
        }
        const n = Number((db.prepare(`SELECT COUNT(*) AS n FROM fssai_receiving_lines WHERE check_id=?`).get(checkId) as any)?.n) || 0;
        db.prepare(`UPDATE fssai_receiving_checks SET line_count=?, updated_at=datetime('now') WHERE id=?`).run(n, checkId);
      });
      tx();

      const out = db.prepare(`${LINE_SELECT} WHERE l.id = ?`).get(id) as any;
      return Response.json({
        ok: true,
        line: shapeLine(out, today),
        would_fail: verdict.fail,
        why: verdict.why,
        missing: lineGaps(out),
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * REMOVE_LINE — only from a draft. A submitted record loses nothing.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'remove_line') {
      const checkId = str(body?.check_id);
      const lineId = str(body?.line_id);
      if (!checkId || !lineId) return Response.json({ error: 'Which line? No id was sent.' }, { status: 400 });
      const row = loadCheck(checkId);
      if (!row) return Response.json({ error: 'That inspection is no longer in the file.' }, { status: 404 });
      const refusal = editRefusal(row);
      if (refusal) return Response.json({ error: refusal, code: 'not_editable' }, { status: fssaiRecordIsEditable(row.status) ? 403 : 409 });

      const line = db.prepare(`SELECT * FROM fssai_receiving_lines WHERE id = ? AND check_id = ?`).get(lineId, checkId) as any;
      if (!line) return Response.json({ error: 'That line is no longer on this inspection.' }, { status: 404 });

      const tx = db.transaction(() => {
        /* A DELETE, and this is the ONE place in the module where that word is
         * right. §19 forbids deleting a RECORD; this row is part of a draft that is
         * not yet a record — nothing has been submitted, nothing has been attested
         * to, and the alternative is a submitted sheet carrying a line somebody
         * added by mistake and could never take off. The audit row still names what
         * went, so even the draft's history survives. */
        db.prepare(`DELETE FROM fssai_attachments WHERE entity_table='fssai_receiving_lines' AND entity_id=?`).run(lineId);
        db.prepare(`DELETE FROM fssai_receiving_lines WHERE id=? AND check_id=?`).run(lineId, checkId);
        const n = Number((db.prepare(`SELECT COUNT(*) AS n FROM fssai_receiving_lines WHERE check_id=?`).get(checkId) as any)?.n) || 0;
        db.prepare(`UPDATE fssai_receiving_checks SET line_count=?, updated_at=datetime('now') WHERE id=?`).run(n, checkId);
        fssaiAuditBestEffort(db, {
          entity_table: 'fssai_receiving_lines', entity_id: lineId, action: 'delete',
          before: {
            material_name: line.material_name, qty_received: fssaiNum(line.qty_received),
            qty_rejected: fssaiNum(line.qty_rejected), decision: line.decision,
          },
          reason: str(body?.reason) || 'Line removed from a draft before it was submitted',
          actor: { email: me.email, name: me.name }, outlet_id: outletId || row.outlet_id || '',
        });
      });
      tx();
      return Response.json({ ok: true, removed: lineId });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * SUBMIT — the verdict is frozen here and never recomputed again.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'submit') {
      const id = str(body?.id);
      if (!id) return Response.json({ error: 'Which inspection? No id was sent.' }, { status: 400 });
      const row = loadCheck(id);
      if (!row) return Response.json({ error: 'That inspection is no longer in the file.' }, { status: 404 });
      const refusal = editRefusal(row);
      if (refusal) return Response.json({ error: refusal, code: 'not_editable' }, { status: fssaiRecordIsEditable(row.status) ? 403 : 409 });

      const lineRows = db.prepare(`SELECT * FROM fssai_receiving_lines WHERE check_id=? ORDER BY sort_order ASC`).all(id) as any[];
      if (!lineRows.length) {
        return Response.json(
          { error: 'There is nothing on this inspection yet. Add the lines that arrived before filing it.', code: 'no_lines' },
          { status: 400 },
        );
      }

      /* ── THE COMPLETENESS GATE ───────────────────────────────────────────
       * An unanswered checkpoint is NOT turned into a failure — that would make an
       * unfinished inspection look like a bad delivery. It blocks the submit
       * instead, and the refusal NAMES what it is waiting for, line by line. This
       * is the shape the checklist engine's `photo_rule`/`note_rule` fix settled
       * on, applied here.
       *
       * `allow_partial` exists because there is a real case for it: a delivery of
       * flour has no temperature and no cold chain, and `na` is the right answer
       * there — but a checker at the door with a queue behind them will sometimes
       * file what they have. So the gap is permitted explicitly, with the gaps
       * recorded in the audit row, and never by default. */
      const gaps = lineRows
        .map((l) => ({ name: String(l.material_name || ''), missing: lineGaps(l) }))
        .filter((x) => x.missing.length);
      if (gaps.length && body?.allow_partial !== true) {
        return Response.json(
          {
            error: `Some checks have not been answered yet: ${gaps.slice(0, 3).map((x) => `${x.name} (${x.missing.join(', ')})`).join('; ')}${gaps.length > 3 ? `, and ${gaps.length - 3} more` : ''}. Answer them, or mark the ones that do not apply as "not applicable" — an unanswered check is not a pass.`,
            code: 'incomplete',
            gaps,
          },
          { status: 400 },
        );
      }

      /* Any rejected line must say what was done about it at the door. The
       * corrective action raised below is the FOLLOW-UP; this is the moment. */
      const rejectedNoReason = lineRows.filter((l) => {
        const v = lineFails(l);
        return v.fail && !String(l.reject_reason || '') && !String(l.note || '');
      });
      if (rejectedNoReason.length) {
        return Response.json(
          {
            error: `${rejectedNoReason.map((l) => String(l.material_name)).slice(0, 3).join(', ')} ${rejectedNoReason.length === 1 ? 'failed its check' : 'failed their checks'} with nothing written against ${rejectedNoReason.length === 1 ? 'it' : 'them'}. Say what was wrong, or what you did about it.`,
            code: 'fail_reason_required',
          },
          { status: 400 },
        );
      }

      let frozen = { fail_count: 0, rejected_count: 0, outcome: '' as string, check_no: '' };
      const raisedActions: any[] = [];

      const tx = db.transaction(() => {
        /* THE NUMBER IS ALLOCATED NOW, INSIDE THE TRANSACTION. The house allocator
         * reads MAX within the transaction, so two inspections submitted in the
         * same second cannot both read the same MAX, and `uq_fssai_rqc_no` is the
         * backstop. */
        const checkNo = String(row.check_no || '') || nextFssaiReceivingNo(db, String(row.business_date || today));
        let fails = 0;
        let rejectedLines = 0;

        for (const l of lineRows) {
          const v = lineFails(l);
          /* THE DECISION THE QUANTITIES IMPLY IS WRITTEN ONLY WHERE THE CHECKER
           * LEFT IT BLANK. An explicit decision is the checker's judgement and this
           * must never overwrite it — a line rejected on quality with nothing sent
           * back yet is a real and common case. */
          const decided = String(l.decision || '') || fssaiReceivingDecisionFor(fssaiNum(l.qty_received), fssaiNum(l.qty_accepted));
          if (v.fail) fails += 1;
          if (decided === 'rejected' || decided === 'partially_accepted') rejectedLines += 1;
          db.prepare(
            `UPDATE fssai_receiving_lines SET is_fail=?, decision=?, updated_at=datetime('now') WHERE id=?`,
          ).run(v.fail ? 1 : 0, decided, String(l.id));
        }

        /* ⚠️ THE OUTCOME IS 'fail' IF *ANY* LINE FAILED, and there is no pass
         * percentage. A delivery is not 80% fit: one rejected pack of chicken is a
         * failed delivery, and a percentage would let a screen round it away. */
        const outcome = fails > 0 ? 'fail' : 'pass';

        const res = db.prepare(
          `UPDATE fssai_receiving_checks
              SET check_no=?, status='submitted', submitted_at=datetime('now'),
                  outcome=?, line_count=?, fail_count=?, rejected_count=?,
                  updated_at=datetime('now')
            WHERE id=? AND status='draft'`,
        ).run(checkNo, outcome, lineRows.length, fails, rejectedLines, id);
        if (res.changes !== 1) throw new Error('FSSAI_RQC_MOVED');

        /* ── OWNER §2/§4: A REJECTED LINE RAISES A CORRECTIVE ACTION ────────
         * One per failed line, not one per inspection: the follow-up is about the
         * chicken, and whoever picks it up needs to know which line. Idempotent on
         * the line's own id through `response_id`, and best-effort — the record is
         * already true without it (§7 Q4). */
        for (const l of lineRows) {
          const v = lineFails(l);
          if (!v.fail || String(l.ca_id || '')) continue;
          try {
            const already = db.prepare(
              `SELECT id FROM fssai_corrective_actions WHERE response_id=? AND source_kind='manual' LIMIT 1`,
            ).get(String(l.id)) as any;
            if (already) continue;
            const caId = generateId();
            const caNo = (() => {
              const year = String(row.business_date || today).slice(0, 4);
              const last = db.prepare(
                `SELECT MAX(CAST(substr(ca_number, length('CA-' || ? || '-') + 1) AS INTEGER)) AS n
                   FROM fssai_corrective_actions WHERE ca_number LIKE 'CA-' || ? || '-%'`,
              ).get(year, year) as any;
              return `CA-${year}-${String((Number(last?.n) || 0) + 1).padStart(4, '0')}`;
            })();
            const reasonLabel = FSSAI_REJECT_REASONS.find((r) => r.key === String(l.reject_reason))?.label || '';
            db.prepare(
              `INSERT INTO fssai_corrective_actions
                 (id, ca_number, source_kind, run_id, response_id, equipment_id, department_id,
                  title, description, severity, status, owner_email, due_date, created_by, outlet_id)
               VALUES (?, ?, 'manual', NULL, ?, '', ?, ?, ?, 'high', 'open', '', ?, ?, ?)`,
            ).run(
              caId, caNo, String(l.id), String(row.department_id || ''),
              `Delivery problem — ${String(l.material_name || 'unnamed line')} from ${String(row.vendor_name || 'a supplier')}`.slice(0, 300),
              [
                `${String(l.material_name || 'This line')} failed its check on delivery ${checkNo}: ${v.why.join('; ')}.`,
                reasonLabel ? `Reason given: ${reasonLabel}.` : '',
                String(l.reject_note || '') ? `Note: “${String(l.reject_note)}”` : '',
                `Received on ${String(row.business_date || '')} from ${String(row.vendor_name || '')}${String(row.invoice_number || '') ? `, bill ${String(row.invoice_number)}` : ''}.`,
              ].filter(Boolean).join(' '),
              addDaysISO(String(row.business_date || today), 3),
              me.email || '', outletId,
            );
            db.prepare(`UPDATE fssai_receiving_lines SET ca_id=? WHERE id=?`).run(caId, String(l.id));
            raisedActions.push({ id: caId, ca_number: caNo, line_id: String(l.id), material_name: String(l.material_name || '') });
          } catch (e) {
            // The failure is on the record in red either way — see §7 Q4.
            console.error('receiving: could not raise the corrective action for a failed line (the record stands):', e);
          }
        }

        /* ── A COLD LINE'S READING ALSO BECOMES A TEMPERATURE LOG ───────────
         * `source_kind='receiving'` and `receiving_line_id` set, so the temperature
         * register and the reports see deliveries without a second place recording
         * them. The verdict is COPIED from the frozen line, never recomputed, so the
         * two rows can never disagree about the same pack.
         *
         * ⚠️ `source_kind` MATTERS FOR THE AUDIT TRAIL and is recorded, never
         * inferred: a reading that came from a delivery inspection is covered by
         * whoever submitted that inspection, not by a temperature round's signature.
         */
        for (const l of lineRows) {
          const temp = fssaiNum(l.temp_c);
          if (temp === null) continue;
          const dupe = db.prepare(
            `SELECT id FROM fssai_temperature_logs WHERE receiving_line_id = ? LIMIT 1`,
          ).get(String(l.id)) as any;
          if (dupe) continue;
          const min = fssaiNum(l.temp_min_used);
          const max = fssaiNum(l.temp_max_used);
          const judged = min !== null || max !== null ? 1 : 0;
          const failed = (min !== null && temp < min) || (max !== null && temp > max) ? 1 : 0;
          db.prepare(
            `INSERT INTO fssai_temperature_logs
               (id, business_date, reading_at, shift, log_kind, source_kind,
                run_id, response_id, receiving_line_id,
                equipment_id, equipment_label, equipment_kind, area_label, department_id,
                material_id, item_label, batch_id, standard_id,
                value_num, uom, decimals, min_used, max_used, target_used,
                elapsed_minutes, max_minutes_used, is_fail, is_judged, fail_reason,
                action_taken, ca_id, note, status, recorded_by, recorded_name, outlet_id)
             VALUES (?, ?, ?, ?, 'delivery', 'receiving', '', '', ?,
                     '', '', '', ?, ?, ?, ?, '', '',
                     ?, 'C', 1, ?, ?, NULL, NULL, NULL, ?, ?, ?,
                     '', ?, ?, 'submitted', ?, ?, ?)`,
          ).run(
            generateId(), String(row.business_date || today), String(row.received_at || ''), String(row.shift || ''),
            String(l.id),
            `At the door — ${String(row.vendor_name || 'delivery')}`.slice(0, 200),
            String(row.department_id || ''), String(l.material_id || ''),
            String(l.material_name || ''),
            temp, min, max,
            failed, judged,
            failed ? `${temp} °C on arrival, outside ${min === null ? '' : min}–${max === null ? '' : max} °C.` : '',
            String(l.ca_id || ''), String(l.reject_note || ''),
            me.email || '', me.name || '', outletId,
          );
        }

        fssaiAuditBestEffort(db, {
          entity_table: 'fssai_receiving_checks', entity_id: id, action: 'submit',
          before: { status: 'draft' },
          after: {
            status: 'submitted', check_no: checkNo, outcome,
            line_count: lineRows.length, fail_count: fails, rejected_count: rejectedLines,
          },
          reason: gaps.length
            ? `Filed with ${gaps.length} line(s) carrying unanswered checks, accepted deliberately: ${gaps.slice(0, 5).map((x) => `${x.name} (${x.missing.join(', ')})`).join('; ')}`
            : (fails > 0 ? `Failed: ${fails} of ${lineRows.length} line(s)` : 'Filed, all lines in order'),
          actor: { email: me.email, name: me.name }, outlet_id: outletId || row.outlet_id || '',
        });

        frozen = { fail_count: fails, rejected_count: rejectedLines, outcome, check_no: checkNo };
      });
      try { tx(); } catch (e: any) {
        if (String(e?.message) === 'FSSAI_RQC_MOVED') {
          return Response.json({ error: 'Somebody has already filed this inspection.', code: 'already_moved' }, { status: 409 });
        }
        throw e;
      }

      fssaiAppAudit(db, {
        event_type: 'fssai.receiving.submit', entity_type: 'fssai_receiving_checks', entity_id: id,
        actor_email: me.email, before: { status: 'draft' },
        after: { status: 'submitted', outcome: frozen.outcome, fail_count: frozen.fail_count },
        note: frozen.check_no,
      });

      const out = db.prepare(`${CHECK_SELECT} WHERE c.id = ?`).get(id) as any;
      const outLines = db.prepare(`${LINE_SELECT} WHERE l.check_id = ? ORDER BY l.sort_order ASC`).all(id) as any[];
      return Response.json({
        ok: true,
        check: shapeCheck(out),
        lines: outLines.map((l) => shapeLine(l, today)),
        corrective_actions: raisedActions,
        note_to_staff: frozen.fail_count > 0
          ? `Filed as ${frozen.check_no}. ${frozen.fail_count} line${frozen.fail_count === 1 ? '' : 's'} failed, and ${raisedActions.length} follow-up job${raisedActions.length === 1 ? '' : 's'} ${raisedActions.length === 1 ? 'has' : 'have'} been raised. This does not change any quantity on the goods receipt — the stock figure stays with the delivery.`
          : `Filed as ${frozen.check_no}, all lines in order. This does not change any quantity on the goods receipt.`,
        /* Said out loud, because a checker who has just rejected a pallet will
         * reasonably expect the stock to have moved. HARD RULE 5. */
        no_stock_movement: 'Nothing was taken out of stock. FSSAI records what was found; the quantity is still the goods receipt\'s to change.',
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * VERIFY — the second pair of eyes, and it changes nothing.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'verify') {
      const id = str(body?.id);
      if (!id) return Response.json({ error: 'Which inspection? No id was sent.' }, { status: 400 });
      const row = loadCheck(id);
      if (!row) return Response.json({ error: 'That inspection is no longer in the file.' }, { status: 404 });
      if (String(row.status) !== 'submitted') {
        return Response.json(
          {
            error: String(row.status) === 'verified' ? 'That inspection has already been checked.'
              : String(row.status) === 'void' ? 'A voided inspection cannot be checked off.'
                : 'That inspection has not been filed yet, so there is nothing to check.',
            code: 'already_moved',
          },
          { status: 409 },
        );
      }
      if (!canVerifyFssai(me, row.checked_by)) {
        const own = String(me.email || '').toLowerCase() === String(row.checked_by || '').toLowerCase();
        return Response.json(
          {
            error: own
              ? 'You inspected this delivery, so somebody else has to check it. That is the whole point of a second pair of eyes.'
              : 'Only a manager, head of department or administrator can check a filed inspection.',
            code: own ? 'own_record' : 'not_allowed',
          },
          { status: 403 },
        );
      }
      const note = str(body?.verify_note).slice(0, 2000);

      const tx = db.transaction(() => {
        /* ⚠️ FOUR COLUMNS AND NOT ONE MORE. Verifying cannot change what the record
         * says — no quantity, no tick-box, no verdict. A caller who sends
         * `fail_count`, `outcome` or a `lines[]` array changes nothing, because
         * nothing below reads them. Same construction as /api/fssai/approvals. */
        const res = db.prepare(
          `UPDATE fssai_receiving_checks
              SET status='verified', verified_by=?, verified_at=datetime('now'), verify_note=?,
                  updated_at=datetime('now')
            WHERE id=? AND status='submitted'`,
        ).run(me.email || '', note, id);
        if (res.changes !== 1) throw new Error('FSSAI_RQC_MOVED');
        fssaiAudit(db, {
          entity_table: 'fssai_receiving_checks', entity_id: id, action: 'verify', field: 'status',
          before: { status: 'submitted' },
          after: { status: 'verified', verified_by: me.email || '' },
          reason: note || 'Checked and accepted',
          actor: { email: me.email, name: me.name }, outlet_id: outletId || row.outlet_id || '',
        });
      });
      try { tx(); } catch (e: any) {
        if (String(e?.message) === 'FSSAI_RQC_MOVED') {
          return Response.json({ error: 'Somebody has already decided on this inspection.', code: 'already_moved' }, { status: 409 });
        }
        throw e;
      }

      const out = db.prepare(`${CHECK_SELECT} WHERE c.id = ?`).get(id) as any;
      return Response.json({
        ok: true,
        check: shapeCheck(out),
        record_unchanged: 'Checking an inspection does not change it. Every quantity, tick-box and verdict reads exactly as it did.',
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * VOID — §19, management only, with a reason, never the checker.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'void') {
      const id = str(body?.id);
      if (!id) return Response.json({ error: 'Which inspection? No id was sent.' }, { status: 400 });
      const row = loadCheck(id);
      if (!row) return Response.json({ error: 'That inspection is no longer in the file.' }, { status: 404 });

      const reason = str(body?.reason).slice(0, 2000);
      const refusal = fssaiVoidRefusal(me, { status: row.status, voided_at: row.voided_at }, reason);
      if (refusal) {
        return Response.json(
          { error: refusal, code: reason.trim().length < 4 ? 'reason_required' : 'not_allowed' },
          { status: reason.trim().length < 4 ? 400 : 403 },
        );
      }
      /* The half the shared helper cannot see — see the identical note in the
       * temperature route. A DRAFT is exempt: nobody else has relied on it, and a
       * checker abandoning their own half-finished sheet is housekeeping, not an
       * erasure. */
      if (String(row.status) !== 'draft'
        && String(me.email || '').trim().toLowerCase() === String(row.checked_by || '').trim().toLowerCase()) {
        return Response.json(
          { error: 'You filed this inspection, so you cannot be the one to strike it out. Ask another manager.', code: 'own_record' },
          { status: 403 },
        );
      }

      const tx = db.transaction(() => {
        const res = db.prepare(
          `UPDATE fssai_receiving_checks
              SET status='void', voided_at=datetime('now'), voided_by=?, void_reason=?,
                  updated_at=datetime('now')
            WHERE id=? AND status <> 'void'`,
        ).run(me.email || '', reason, id);
        if (res.changes !== 1) throw new Error('FSSAI_RQC_MOVED');
        /* ⚠️ THE LINES ARE NOT DELETED, and the CASCADE never fires here: this is an
         * UPDATE, not a DELETE. The sheet stays readable, struck out, exactly as §19
         * requires. The CASCADE on `check_id` only ever fires if a draft row is
         * genuinely removed. */
        fssaiAudit(db, {
          entity_table: 'fssai_receiving_checks', entity_id: id, action: 'void', field: 'status',
          before: {
            status: row.status, check_no: row.check_no, outcome: row.outcome,
            fail_count: Number(row.fail_count) || 0, line_count: Number(row.line_count) || 0,
          },
          after: { status: 'void', voided_by: me.email || '' },
          reason,
          actor: { email: me.email, name: me.name }, outlet_id: outletId || row.outlet_id || '',
        });
      });
      try { tx(); } catch (e: any) {
        if (String(e?.message) === 'FSSAI_RQC_MOVED') {
          return Response.json({ error: 'That inspection has already been voided.', code: 'already_moved' }, { status: 409 });
        }
        throw e;
      }

      fssaiAppAudit(db, {
        event_type: 'fssai.receiving.void', entity_type: 'fssai_receiving_checks', entity_id: id,
        actor_email: me.email, before: { status: row.status }, after: { status: 'void' }, note: reason,
      });

      const openCas = Number((db.prepare(
        `SELECT COUNT(*) AS n FROM fssai_corrective_actions
          WHERE response_id IN (SELECT id FROM fssai_receiving_lines WHERE check_id = ?)
            AND status IN ('open','in_progress','done')`,
      ).get(id) as any)?.n) || 0;

      const out = db.prepare(`${CHECK_SELECT} WHERE c.id = ?`).get(id) as any;
      return Response.json({
        ok: true,
        check: shapeCheck(out),
        note: openCas
          ? `Voided with your reason on it. ${openCas} follow-up job${openCas === 1 ? ' is' : 's are'} still open against its lines — a void says the inspection was entered wrongly, not that the goods were fine. Cancel those separately if they should not have been raised.`
          : 'Voided with your reason on it. The lines stay exactly as they were written, struck out, with who voided it and why.',
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * ATTACH — the photograph the supplier will argue about later.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'attach') {
      const checkId = str(body?.check_id) || str(body?.id);
      if (!checkId) return Response.json({ error: 'Which inspection? No id was sent.' }, { status: 400 });
      const row = loadCheck(checkId);
      if (!row) return Response.json({ error: 'That inspection is no longer in the file.' }, { status: 404 });
      if (String(row.status) === 'void') {
        return Response.json({ error: 'A voided inspection does not take new photographs.', code: 'voided' }, { status: 409 });
      }
      const mine = String(me.email || '').toLowerCase() === String(row.checked_by || '').toLowerCase();
      if (!mine && !isManagement(me)) {
        return Response.json(
          { error: 'Only the person who inspected this delivery, or a manager, can attach a photograph to it.', code: 'not_allowed' },
          { status: 403 },
        );
      }

      /* A photograph may hang off the INSPECTION or off one LINE. A line is the
       * useful one — "this is the pack that was leaking" — and the entity table is
       * chosen here rather than taken from the caller, so a request can never aim
       * an attachment at a table of its choosing. */
      const lineId = str(body?.line_id);
      let entityTable = 'fssai_receiving_checks';
      let entityId = checkId;
      if (lineId) {
        const line = db.prepare(`SELECT id FROM fssai_receiving_lines WHERE id=? AND check_id=?`).get(lineId, checkId) as any;
        if (!line) return Response.json({ error: 'That line is not on this inspection.' }, { status: 404 });
        entityTable = 'fssai_receiving_lines';
        entityId = lineId;
      }

      const have = Number((db.prepare(
        `SELECT COUNT(*) AS n FROM fssai_attachments WHERE entity_table=? AND entity_id=?`,
      ).get(entityTable, entityId) as any)?.n) || 0;
      if (have >= 4) {
        return Response.json(
          { error: lineId ? 'Four photographs is the limit on one line.' : 'Four photographs is the limit on the inspection itself. Attach the rest to the lines they are about.', code: 'too_many' },
          { status: 409 },
        );
      }
      /* 24 PER INSPECTION, the same ceiling a checklist round carries, counted
       * across the header and every line — otherwise thirty lines at four each is
       * a 30 MB record. */
      const total = Number((db.prepare(
        `SELECT (SELECT COUNT(*) FROM fssai_attachments WHERE entity_table='fssai_receiving_checks' AND entity_id=?)
              + (SELECT COUNT(*) FROM fssai_attachments WHERE entity_table='fssai_receiving_lines'
                  AND entity_id IN (SELECT id FROM fssai_receiving_lines WHERE check_id=?)) AS n`,
      ).get(checkId, checkId) as any)?.n) || 0;
      if (total >= 24) {
        return Response.json(
          { error: 'Twenty-four photographs is the limit on one inspection.', code: 'too_many_total' },
          { status: 409 },
        );
      }

      const w = writeFssaiAttachment(db, {
        entityTable, entityId, kind: str(body?.kind) || 'photo',
        dataUri: str(body?.data_uri), filename: str(body?.filename), caption: str(body?.caption),
        actorEmail: me.email, outletId: outletId || row.outlet_id || '',
      });
      if (!w.ok) return Response.json({ error: w.error }, { status: w.status });
      fssaiAuditBestEffort(db, {
        entity_table: entityTable, entity_id: entityId, action: 'update',
        field: 'attachment', after: { attachment_id: w.id, bytes: w.bytes },
        reason: 'Photograph attached', actor: { email: me.email, name: me.name },
        outlet_id: outletId || row.outlet_id || '',
      });
      return Response.json({ ok: true, id: w.id, bytes: w.bytes, photo_count: have + 1, total });
    }

    return Response.json(
      {
        error: `"${action}" is not something that can be done to a delivery inspection. Use create, save_header, save_line, remove_line, submit, verify, void or attach.`,
      },
      { status: 400 },
    );
  } catch (e: any) {
    console.error('POST /api/fssai/receiving failed:', e);
    return Response.json({ error: e?.message || 'Failed to save that' }, { status: 500 });
  }
}

/* No DELETE of a submitted inspection. One that should never have been filed is
 * VOIDED with a written reason and stays readable, lines and all (owner §19). The
 * only rows this file removes are lines off a DRAFT — a sheet that is not yet a
 * record — and even those leave an audit row naming what went. */
