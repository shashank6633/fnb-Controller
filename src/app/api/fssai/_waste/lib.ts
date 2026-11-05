/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * THE WASTE HANDOVER LOG — Hyderabad Food Safety audit checklist line #114,
 * "Records You Should Keep Ready in One Audit File: Waste disposal record".
 *
 * ── WHAT WAS THERE BEFORE, AND WHY IT WAS NOT ENOUGH ────────────────────────
 * Only a document slot ('waste_disposal_record' in Documents & Certificates),
 * where one collector's receipt counted for 92 days. That answers "do you have
 * an agreement with somebody" — not "where did yesterday's waste go". The
 * authority's record is a LOG OF EACH HANDOVER: the date, wet / dry / other, how
 * much, who collected it (GHMC or an agency), the receipt or vehicle number, and
 * who handed it over. One row of fssai_waste_handovers is one of those.
 *
 * ── THE RULES THIS FILE ENFORCES (each one is proved by constructing its case) ─
 *   · NULL MEANS NOT HANDED OVER, never 0. A stream left blank was not on this
 *     visit; a stream typed as 0 is refused, because "0 kg of wet waste left the
 *     building" is not a handover of anything.
 *   · A handover carries SOMETHING: all three streams blank is refused.
 *   · "Other" says what it was (glass, e-waste, sanitary). A quantity with no
 *     words is unreadable to an inspector.
 *   · PROOF: a receipt number or a vehicle number — or, when there genuinely is
 *     neither, a sentence in the note saying so. A blank pair answers nothing.
 *   · An AGENCY carries its registration, or a sentence saying why not — the
 *     same rule the used-oil register settled (oil/disposals/route.ts).
 *   · The date is never in the future; a backdated entry is accepted and SAID in
 *     the audit row.
 *   · The same paper receipt cannot be filed twice from the same collector, and a
 *     double-tap at the back door within WASTE_DUPLICATE_WINDOW_MIN minutes is
 *     refused with the number of the handover already saved.
 *   · Vendors, departments and documents are READ, never created (HARD RULES 3/4).
 *   · There is NO money column (see the DDL) and nothing here moves stock.
 *
 * ── VOID, NEVER DELETE ──────────────────────────────────────────────────────
 * A handover is cancelled through the ONE shared void (/api/fssai/void →
 * src/lib/fssai-void.ts), never here. A photograph on a handover is voided by
 * voidWasteAttachment below: status 'void' + who + when + why, the image KEPT
 * (owner ruling Q22, 2026-10-14) — data_uri is never blanked and image_dropped_at
 * is never set by this file. Grep it: there is no DELETE.
 *
 * ── FOR THE AUDIT-FILE LANE ─────────────────────────────────────────────────
 * wasteHandoverAuditPart() returns record 14's verdict, tables and scans in the
 * same field names the audit file's AuditFileItem uses, so it can be dropped in
 * without translation. It never imports from the audit-file lib.
 */

import type Database from 'better-sqlite3';
import { isManagement, type SessionUser } from '@/lib/auth';
import {
  fssaiToday, isISODate, daysBetweenISO, fssaiRecordStatusMeta, fssaiVoidRefusal,
  FSSAI_PHOTO_MIMES,
} from '@/lib/fssai';
import { fssaiAudit, fssaiAppAudit, str } from '@/lib/fssai-server';
import { FSSAI_ADMIN_MAY_VOID_OWN_RECORD } from '@/lib/fssai-void';
import { num, readBusinessDate, readClock, p5VisibilityClause, real, voidFields } from '../_p5/records';
import {
  WASTE_DUPLICATE_WINDOW_MIN, WASTE_HANDOVER_CADENCE, WASTE_HANDOVER_PREFIX,
  WASTE_QTY_UOMS, isWasteCollectorKind, isWasteUom, wasteCollectorLabel,
} from './vocab';

export const WASTE_TABLE = 'fssai_waste_handovers' as const;
export const WASTE_PAGE = '/fssai/waste';
export const WASTE_PAGE_LABEL = 'Waste Handover Log';
export const WASTE_LIST_LIMIT = 500;

/** The document type the collector's agreement is filed under (Documents & Certificates). */
export const WASTE_AGREEMENT_DOC_TYPE = 'waste_disposal_record';

/* ------------------------------------------------------------------ *
 * Small date helpers (business dates, IST, YYYY-MM-DD)
 * ------------------------------------------------------------------ */

export function addDaysISO(iso: string, n: number): string {
  if (!isISODate(iso)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** Every date from `from` to `to` inclusive. Capped at 400 so a typo cannot build a million-row list. */
export function datesBetween(from: string, to: string): string[] {
  if (!isISODate(from) || !isISODate(to) || from > to) return [];
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDaysISO(d, 1)) out.push(d);
  return out;
}

/* ------------------------------------------------------------------ *
 * The number on the paper — 'WST-2026-0001'
 * ------------------------------------------------------------------ */

/**
 * The house allocator (MAX of the numeric tail inside the year's prefix), per
 * outlet. Called INSIDE the write transaction, so two handovers saved in the same
 * instant cannot read the same MAX; uq_fssai_waste_no is the backstop.
 */
export function nextWasteHandoverNo(db: Database.Database, isoDate: string, outletId: string): string {
  const year = /^\d{4}-/.test(str(isoDate)) ? str(isoDate).slice(0, 4) : String(new Date().getFullYear());
  const like = `${WASTE_HANDOVER_PREFIX}-${year}-`;
  const row = db.prepare(
    `SELECT MAX(CAST(substr(handover_no, length(?) + 1) AS INTEGER)) AS n
       FROM fssai_waste_handovers WHERE outlet_id = ? AND handover_no LIKE ? || '%'`,
  ).get(like, outletId, like) as any;
  return `${like}${String((Number(row?.n) || 0) + 1).padStart(4, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Shaping
 * ------------------------------------------------------------------ */

export interface WastePhoto {
  id: string;
  kind: string;
  filename: string;
  mime: string;
  size_bytes: number;
  caption: string;
  created_by: string;
  created_at: string;
  /** 'active' | 'void' — a voided photo is SHOWN as voided, never hidden. */
  status: string;
  voided_at: string;
  voided_by: string;
  void_reason: string;
  /** Only rows a pre-2026-10-14 build blanked. Nothing in this lane sets it. */
  image_dropped_at: string;
  has_image: boolean;
}

export const WASTE_SELECT = `
  SELECT w.*, v.name AS vendor_name, d.name AS department_name,
         doc.title AS document_title, doc.reference_no AS document_reference,
         doc.expiry_date AS document_expiry, doc.status AS document_status
    FROM fssai_waste_handovers w
    LEFT JOIN vendors v          ON v.id = w.vendor_id
    LEFT JOIN departments d      ON d.id = w.department_id
    LEFT JOIN fssai_documents doc ON doc.id = w.document_id`;

/** "12.5 kg" / "3 bags" / '' — NEVER "0 kg" for a stream that was not handed over. */
export function wasteQtyText(v: number | null, uom: string): string {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '';
  const n = Number(v);
  const shown = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  return `${shown} ${uom || 'kg'}`;
}

export function shapeWasteHandover(row: any) {
  const uom = String(row.qty_uom || 'kg');
  const wet = real(row.wet_qty);
  const dry = real(row.dry_qty);
  const other = real(row.other_qty);
  const receipt = String(row.receipt_no || '');
  const vehicle = String(row.vehicle_no || '');
  return {
    id: String(row.id),
    handover_no: String(row.handover_no || ''),
    business_date: String(row.business_date || ''),
    handed_at: String(row.handed_at || ''),
    /* NULL = that stream was not on this handover. Kept null on the wire so a
     * screen can never print 0 for it. */
    wet_qty: wet,
    dry_qty: dry,
    other_qty: other,
    other_kind: String(row.other_kind || ''),
    qty_uom: uom,
    wet_text: wasteQtyText(wet, uom),
    dry_text: wasteQtyText(dry, uom),
    other_text: wasteQtyText(other, uom),
    collector_kind: String(row.collector_kind || ''),
    collector_kind_label: wasteCollectorLabel(row.collector_kind),
    collector_name: String(row.collector_name || ''),
    vendor_id: String(row.vendor_id || ''),
    vendor_name: String(row.vendor_name || ''),
    agency_reg_no: String(row.agency_reg_no || ''),
    receipt_no: receipt,
    vehicle_no: vehicle,
    /** Neither a receipt nor a vehicle number: the handover rests on its note alone. */
    lacks_proof: !receipt && !vehicle,
    received_by_name: String(row.received_by_name || ''),
    handed_over_name: String(row.handed_over_name || ''),
    department_id: String(row.department_id || ''),
    department_name: String(row.department_name || ''),
    document_id: String(row.document_id || ''),
    document_title: String(row.document_title || ''),
    document_reference: String(row.document_reference || ''),
    document_expiry: String(row.document_expiry || ''),
    /** The linked agreement has since been voided — shown, not hidden. */
    document_voided: String(row.document_status || '') === 'void',
    note: String(row.note || ''),
    status: String(row.status || 'submitted'),
    status_label: fssaiRecordStatusMeta(row.status).label,
    recorded_by: String(row.recorded_by || ''),
    recorded_name: String(row.recorded_name || ''),
    outlet_id: String(row.outlet_id || ''),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || ''),
    ...voidFields(row),
  };
}

export type WasteHandoverView = ReturnType<typeof shapeWasteHandover>;

/**
 * "Ramky Enviro · Authorised agency · reg R-77" for a register line. The kind is
 * left out when it IS the name (GHMC · GHMC), and an agency with no registration
 * says so with the note that explains it — the line an inspector reads.
 */
export function wasteCollectorText(r: WasteHandoverView): string {
  const name = r.vendor_name || r.collector_name;
  const parts = [name];
  if (r.collector_kind_label && r.collector_kind_label.toLowerCase() !== name.toLowerCase()) parts.push(r.collector_kind_label);
  if (r.agency_reg_no) parts.push(`reg ${r.agency_reg_no}`);
  else if (r.collector_kind === 'agency') parts.push(`reg not recorded${r.note ? ` — ${r.note}` : ''}`);
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ *
 * Photographs (fssai_attachments, entity_table = fssai_waste_handovers)
 * ------------------------------------------------------------------ */

function shapePhoto(r: any): WastePhoto {
  return {
    id: String(r.id),
    kind: String(r.kind || 'photo'),
    filename: String(r.filename || ''),
    mime: String(r.mime || ''),
    size_bytes: Number(r.size_bytes) || 0,
    caption: String(r.caption || ''),
    created_by: String(r.created_by || ''),
    created_at: String(r.created_at || ''),
    status: String(r.status || 'active'),
    voided_at: String(r.voided_at || ''),
    voided_by: String(r.voided_by || ''),
    void_reason: String(r.void_reason || ''),
    image_dropped_at: String(r.image_dropped_at || ''),
    has_image: Number(r.has_image) === 1,
  };
}

/**
 * Every photograph on these handovers — ACTIVE AND VOID, oldest first. The image
 * itself is never in the list (it is TEXT in-row); a screen asks the photo route
 * for each one it shows.
 */
export function readWastePhotos(db: Database.Database, ids: string[]): Map<string, WastePhoto[]> {
  const out = new Map<string, WastePhoto[]>();
  if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = db.prepare(
      `SELECT id, entity_id, kind, filename, mime, size_bytes, caption, created_by, created_at,
              status, voided_at, voided_by, void_reason, image_dropped_at,
              (data_uri <> '') AS has_image
         FROM fssai_attachments
        WHERE entity_table = ? AND entity_id IN (${chunk.map(() => '?').join(',')})
        ORDER BY created_at ASC, rowid ASC`,
    ).all(WASTE_TABLE, ...chunk) as any[];
    for (const r of rows) {
      const k = String(r.entity_id);
      if (!out.has(k)) out.set(k, []);
      out.get(k)!.push(shapePhoto(r));
    }
  }
  return out;
}

export function countActiveWastePhotos(db: Database.Database, handoverId: string): number {
  const r = db.prepare(
    `SELECT COUNT(*) AS n FROM fssai_attachments
      WHERE entity_table = ? AND entity_id = ? AND status <> 'void' AND voided_at = ''`,
  ).get(WASTE_TABLE, handoverId) as any;
  return Number(r?.n) || 0;
}

/** One stored image, with the handover it hangs off, for the photo route. */
export function readWastePhotoImage(db: Database.Database, attachmentId: string) {
  const row = db.prepare(
    `SELECT a.id, a.entity_id, a.mime, a.data_uri, a.filename, a.image_dropped_at, a.status,
            w.department_id, w.recorded_by
       FROM fssai_attachments a
       JOIN fssai_waste_handovers w ON w.id = a.entity_id
      WHERE a.id = ? AND a.entity_table = ?`,
  ).get(attachmentId, WASTE_TABLE) as any;
  if (!row) return null;
  const mime = String(row.mime || '');
  return {
    id: String(row.id),
    entity_id: String(row.entity_id),
    // Checked on the way OUT as well as in — the column is handed to a browser.
    mime: FSSAI_PHOTO_MIMES.includes(mime) ? mime : '',
    data_uri: String(row.data_uri || ''),
    filename: String(row.filename || ''),
    image_dropped_at: String(row.image_dropped_at || ''),
    status: String(row.status || 'active'),
    parent: { department_id: String(row.department_id || ''), recorded_by: String(row.recorded_by || '') },
  };
}

/**
 * VOID ONE PHOTOGRAPH ON A HANDOVER. The image is KEPT (Q22).
 *
 * The rules are the shared ones, in the shared words:
 *   1. the file must be on THIS handover (a mismatched pair is a 404, not a hint);
 *   2. fssaiVoidRefusal — signed in, management, a reason of 4+ characters, not
 *      already void;
 *   3. never the person who attached it, except an administrator (the reasoning
 *      is in src/lib/fssai-void.ts — there is no tier above admin);
 *   4. a voided handover's files are closed evidence and stay as they are.
 * The UPDATE and its fssai_audit_log row are ONE transaction, and fssaiAudit
 * throws: a void that cannot be traced does not happen.
 */
export function voidWasteAttachment(
  db: Database.Database,
  p: {
    handoverId: string;
    attachmentId: string;
    reason: string;
    me: SessionUser;
    outletId: string;
  },
): { ok: true; photo: WastePhoto } | { error: string; status: number } {
  const row = db.prepare(
    `SELECT id, entity_table, entity_id, status, voided_at, created_by, filename, mime,
            size_bytes, digest_sha256, created_at
       FROM fssai_attachments WHERE id = ?`,
  ).get(str(p.attachmentId)) as any;
  if (!row || str(row.entity_table) !== WASTE_TABLE || str(row.entity_id) !== str(p.handoverId)) {
    return { error: 'That photograph is not on this handover.', status: 404 };
  }

  const refusal = fssaiVoidRefusal(p.me, { status: str(row.status) === 'void' ? 'void' : 'active', voided_at: str(row.voided_at) }, p.reason);
  if (refusal) {
    const already = /already been voided/.test(refusal);
    return {
      error: already ? 'That photograph has already been voided. The first reason stands.' : refusal,
      status: already ? 409 : /reason|words/i.test(refusal) ? 400 : 403,
    };
  }

  const mine = str(p.me.email).trim().toLowerCase();
  const uploader = str(row.created_by).trim().toLowerCase();
  const selfVoid = !!mine && !!uploader && mine === uploader;
  if (selfVoid && !(p.me.role === 'admin' && FSSAI_ADMIN_MAY_VOID_OWN_RECORD)) {
    return { error: 'You attached this photograph yourself, so somebody else must void it — ask another manager or an administrator.', status: 403 };
  }

  const parent = db.prepare(`SELECT id, status, voided_at, handover_no, outlet_id FROM fssai_waste_handovers WHERE id = ?`).get(str(p.handoverId)) as any;
  if (!parent) return { error: 'That handover no longer exists.', status: 404 };
  if (str(parent.status) === 'void' || str(parent.voided_at)) {
    return { error: 'This handover has been voided, so it is closed evidence and its photographs stay as they are.', status: 409 };
  }

  const reason = str(p.reason).trim().slice(0, 2000);
  let changed = 0;
  try {
    db.transaction(() => {
      /* data_uri is NOT in this statement and never will be. */
      const res = db.prepare(
        `UPDATE fssai_attachments
            SET status = 'void', voided_at = datetime('now'), voided_by = ?, void_reason = ?
          WHERE id = ? AND entity_table = ? AND entity_id = ? AND status <> 'void' AND voided_at = ''`,
      ).run(p.me.email || '', reason, row.id, WASTE_TABLE, str(p.handoverId));
      changed = res.changes;
      if (changed !== 1) return;
      fssaiAudit(db, {
        entity_table: WASTE_TABLE,
        entity_id: str(p.handoverId),
        action: 'attachment_void',
        field: 'attachment',
        before: {
          attachment_id: row.id, status: str(row.status) || 'active', filename: row.filename, mime: row.mime,
          size_bytes: row.size_bytes, digest_sha256: row.digest_sha256, created_by: row.created_by, created_at: row.created_at,
        },
        after: {
          attachment_id: row.id, status: 'void', voided_by: p.me.email || '', void_reason: reason,
          // Restated so the trail row itself proves the file was kept.
          file_kept: true, size_bytes: row.size_bytes, digest_sha256: row.digest_sha256, self_void: selfVoid,
        },
        reason,
        actor: { email: p.me.email, name: p.me.name },
        outlet_id: p.outletId || str(parent.outlet_id),
      });
    })();
  } catch (e: any) {
    console.error('[fssai] waste photo void rolled back — its audit row could not be written:', e?.message);
    return { error: 'The void could not be recorded, so nothing changed. The photograph is still on the handover as it was.', status: 500 };
  }
  if (changed !== 1) return { error: 'That photograph has already been voided. The first reason stands.', status: 409 };

  fssaiAppAudit(db, {
    event_type: 'fssai.waste_photo.void', entity_type: WASTE_TABLE, entity_id: str(p.handoverId),
    actor_email: p.me.email || '',
    before: { attachment_id: row.id, status: 'active' }, after: { attachment_id: row.id, status: 'void' }, note: reason,
  });
  const fresh = db.prepare(
    `SELECT id, kind, filename, mime, size_bytes, caption, created_by, created_at, status, voided_at,
            voided_by, void_reason, image_dropped_at, (data_uri <> '') AS has_image
       FROM fssai_attachments WHERE id = ?`,
  ).get(row.id) as any;
  return { ok: true, photo: shapePhoto(fresh) };
}

/* ------------------------------------------------------------------ *
 * Reading a handover off a request body
 * ------------------------------------------------------------------ */

export interface WasteHandoverValues {
  business_date: string;
  backdated: boolean;
  handed_at: string;
  wet_qty: number | null;
  dry_qty: number | null;
  other_qty: number | null;
  other_kind: string;
  qty_uom: string;
  collector_kind: string;
  collector_name: string;
  vendor_id: string;
  agency_reg_no: string;
  receipt_no: string;
  vehicle_no: string;
  received_by_name: string;
  handed_over_name: string;
  department_id: string;
  document_id: string;
  note: string;
}

export type WasteRefusal = { ok: false; status: number; error: string; code: string };

function refuse(code: string, error: string, status = 400): WasteRefusal {
  return { ok: false, status, error, code };
}

/** A quantity that was TYPED but is not a number — refused, never read as blank. */
function typedButNotANumber(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  return num(v) === null;
}

/**
 * Validate one handover. Every refusal names what to do in plain words and
 * carries a stable `code` so a probe can assert WHICH rule fired.
 */
export function readWasteHandover(
  db: Database.Database,
  body: any,
  me: SessionUser,
  today: string = fssaiToday(),
): { ok: true; v: WasteHandoverValues } | WasteRefusal {
  const date = readBusinessDate(body?.business_date, today);
  if (!date.ok) return refuse(/future/.test(date.error) ? 'future_date' : 'bad_date', date.error);

  const rawClock = str(body?.handed_at);
  const handedAt = readClock(rawClock);
  if (rawClock && !handedAt) {
    return refuse('bad_time', `"${rawClock}" is not a time. Use HH:MM, for example 07:30.`);
  }

  /* ── The three streams. NULL = not on this handover. ─────────────────── */
  const streams: Array<['wet' | 'dry' | 'other', unknown]> = [
    ['wet', body?.wet_qty], ['dry', body?.dry_qty], ['other', body?.other_qty],
  ];
  for (const [label, v] of streams) {
    if (typedButNotANumber(v)) {
      return refuse('bad_qty', `"${String(v)}" is not a quantity for the ${label} waste. Type a number, or leave it blank if no ${label} waste went.`);
    }
    const n = num(v);
    if (n !== null && n <= 0) {
      return refuse('qty_not_positive', `${n} is not a quantity of ${label} waste. Leave it blank if no ${label} waste went on this handover.`);
    }
    if (n !== null && n > 100000) {
      return refuse('qty_implausible', `${n} for the ${label} waste looks like a typing slip. Check the number on the receipt.`);
    }
  }
  const wet = num(body?.wet_qty);
  const dry = num(body?.dry_qty);
  const other = num(body?.other_qty);
  if (wet === null && dry === null && other === null) {
    return refuse('nothing_handed_over', 'Enter how much went — wet, dry or other. A handover that carried nothing is not a handover.');
  }
  const otherKind = str(body?.other_kind).slice(0, 120);
  if (other !== null && !otherKind) {
    return refuse('other_kind_required', 'Say what the "other" waste was (glass, cartons, e-waste, sanitary…). A quantity with no words cannot be read by an inspector.');
  }
  if (other === null && otherKind) {
    return refuse('other_qty_required', `You wrote "${otherKind}" as other waste but not how much. Enter the quantity, or clear the words.`);
  }

  const uom = str(body?.qty_uom) || 'kg';
  if (!isWasteUom(uom)) {
    return refuse('bad_uom', `"${uom}" is not a unit this log uses. Use ${WASTE_QTY_UOMS.map((u) => u.key).join(', ')}.`);
  }

  /* ── Who took it. ───────────────────────────────────────────────────── */
  const kind = str(body?.collector_kind);
  if (!isWasteCollectorKind(kind)) {
    return refuse('collector_kind_required', 'Who collected it? Choose GHMC, an authorised agency, or other.');
  }
  const vendorId = str(body?.vendor_id);
  let collectorName = str(body?.collector_name).slice(0, 200);
  if (vendorId) {
    const v = db.prepare(`SELECT id, name FROM vendors WHERE id = ?`).get(vendorId) as any;
    if (!v) {
      return refuse('unknown_vendor', 'That collector is not in the vendor list. Add the agency there first — this log never creates vendors.');
    }
    if (!collectorName) collectorName = String(v.name || '');
  }
  if (!collectorName && kind === 'ghmc') collectorName = 'GHMC';
  if (!collectorName) {
    return refuse('collector_name_required', 'Type the name of the agency or the person who collected it.');
  }

  const note = str(body?.note).slice(0, 2000);
  const agencyRegNo = str(body?.agency_reg_no).slice(0, 120);
  if (kind === 'agency' && !agencyRegNo && !note) {
    return refuse(
      'registration_or_note',
      'Enter the agency\'s registration number. If it has none, say so in the note — waste handed to an unregistered collector is what an inspector asks about, and a blank box answers nothing.',
    );
  }

  const receipt = str(body?.receipt_no).slice(0, 120);
  const vehicle = str(body?.vehicle_no).slice(0, 60).toUpperCase();
  if (!receipt && !vehicle && !note) {
    return refuse(
      'receipt_or_vehicle_or_note',
      'Enter the receipt number or the vehicle number. If there was neither, say why in the note — that sentence is the record.',
    );
  }

  /* ── Who handed it over — the person at the door, who may have no login. ─ */
  const handedOver = (str(body?.handed_over_name) || str(me.name) || str(me.email)).slice(0, 120);
  if (!handedOver) {
    return refuse('handed_over_required', 'Who handed it over? Type the name of the person at the door.');
  }

  /* ── References that are READ, never created. ───────────────────────── */
  const departmentId = str(body?.department_id);
  if (departmentId) {
    const d = db.prepare(`SELECT id FROM departments WHERE id = ?`).get(departmentId) as any;
    if (!d) return refuse('unknown_department', 'That department does not exist. Leave it blank for a handover from the whole restaurant.');
  }
  const documentId = str(body?.document_id);
  if (documentId) {
    const doc = db.prepare(`SELECT id, doc_type, status FROM fssai_documents WHERE id = ?`).get(documentId) as any;
    if (!doc || str(doc.doc_type) !== WASTE_AGREEMENT_DOC_TYPE) {
      return refuse('bad_document', 'That is not a waste disposal record in Documents & Certificates. Pick the collector\'s agreement from the list, or leave it blank.');
    }
    if (str(doc.status) === 'void') {
      return refuse('bad_document', 'That agreement has been voided in Documents & Certificates, so a new handover cannot rest on it.');
    }
  }

  return {
    ok: true,
    v: {
      business_date: date.date,
      backdated: date.backdated,
      handed_at: handedAt,
      wet_qty: wet,
      dry_qty: dry,
      other_qty: other,
      other_kind: otherKind,
      qty_uom: uom,
      collector_kind: kind,
      collector_name: collectorName,
      vendor_id: vendorId,
      agency_reg_no: agencyRegNo,
      receipt_no: receipt,
      vehicle_no: vehicle,
      received_by_name: str(body?.received_by_name).slice(0, 120),
      handed_over_name: handedOver,
      department_id: departmentId,
      document_id: documentId,
      note,
    },
  };
}

/* ------------------------------------------------------------------ *
 * The two "you already filed this" guards
 * ------------------------------------------------------------------ */

/**
 * Run INSIDE the write transaction. Returns the existing handover that makes
 * this one a duplicate, and which rule matched, or null.
 *
 *   receipt  — the same receipt number from the same collector, on any date.
 *              A receipt book does not repeat its numbers; a second row for one
 *              receipt is the same waste counted twice.
 *   resubmit — the same person, date, time, collector and quantities, saved in
 *              the last WASTE_DUPLICATE_WINDOW_MIN minutes: the button pressed
 *              twice on a slow connection.
 * Voided rows never block — a voided handover may be re-filed correctly.
 */
export function findWasteDuplicate(
  db: Database.Database,
  v: WasteHandoverValues,
  me: SessionUser,
  outletId: string,
): { rule: 'receipt' | 'resubmit'; row: any } | null {
  if (v.receipt_no) {
    const r = db.prepare(
      `SELECT id, handover_no, business_date FROM fssai_waste_handovers
        WHERE outlet_id = ? AND status <> 'void' AND voided_at = ''
          AND lower(trim(receipt_no)) = lower(trim(?))
          AND lower(trim(collector_name)) = lower(trim(?))
        LIMIT 1`,
    ).get(outletId, v.receipt_no, v.collector_name) as any;
    if (r) return { rule: 'receipt', row: r };
  }
  const r2 = db.prepare(
    `SELECT id, handover_no, business_date FROM fssai_waste_handovers
      WHERE outlet_id = ? AND status <> 'void' AND voided_at = ''
        AND lower(recorded_by) = lower(?)
        AND business_date = ? AND handed_at = ?
        AND collector_kind = ? AND lower(trim(collector_name)) = lower(trim(?))
        AND wet_qty IS ? AND dry_qty IS ? AND other_qty IS ?
        AND created_at >= datetime('now', ?)
      ORDER BY created_at DESC LIMIT 1`,
  ).get(
    outletId, me.email || '', v.business_date, v.handed_at, v.collector_kind, v.collector_name,
    v.wet_qty, v.dry_qty, v.other_qty, `-${WASTE_DUPLICATE_WINDOW_MIN} minutes`,
  ) as any;
  if (r2) return { rule: 'resubmit', row: r2 };
  return null;
}

/* ------------------------------------------------------------------ *
 * The register, read
 * ------------------------------------------------------------------ */

export interface WasteRegisterQuery {
  from: string;
  to: string;
  /** 'live' (default) | 'void' | 'all' */
  status?: string;
  q?: string;
  limit?: number;
}

/**
 * The handovers a person may see, newest first, with their photographs.
 * Management sees all; anyone else sees restaurant-wide rows (no department),
 * their own department's, and the ones they recorded — the module's one rule
 * (p5VisibilityClause), not a second one.
 */
export function readWasteRegister(db: Database.Database, me: SessionUser | null, query: WasteRegisterQuery) {
  const where: string[] = ['w.business_date >= ?', 'w.business_date <= ?'];
  const args: any[] = [query.from, query.to];
  const status = query.status || 'live';
  if (status === 'live') where.push(`w.status <> 'void' AND w.voided_at = ''`);
  else if (status === 'void') where.push(`(w.status = 'void' OR w.voided_at <> '')`);
  if (me) {
    const vis = p5VisibilityClause(me, 'w', 'recorded_by');
    if (vis.sql) { where.push(vis.sql); args.push(...vis.args); }
  }
  const limit = Math.max(1, Math.min(query.limit || WASTE_LIST_LIMIT, WASTE_LIST_LIMIT));
  const rows = db.prepare(
    `${WASTE_SELECT}
      WHERE ${where.join(' AND ')}
      ORDER BY w.business_date DESC, w.handed_at DESC, w.created_at DESC, w.rowid DESC
      LIMIT ${limit + 1}`,
  ).all(...args) as any[];
  const truncated = rows.length > limit;
  const q = str(query.q).toLowerCase();
  const shaped = rows.slice(0, limit).map(shapeWasteHandover).filter((r) => !q
    || r.handover_no.toLowerCase().includes(q)
    || r.collector_name.toLowerCase().includes(q)
    || r.vendor_name.toLowerCase().includes(q)
    || r.receipt_no.toLowerCase().includes(q)
    || r.vehicle_no.toLowerCase().includes(q)
    || r.agency_reg_no.toLowerCase().includes(q)
    || r.handed_over_name.toLowerCase().includes(q)
    || r.other_kind.toLowerCase().includes(q));
  const photos = readWastePhotos(db, shaped.map((r) => r.id));
  return {
    handovers: shaped.map((r) => ({ ...r, photos: photos.get(r.id) || [] })),
    truncated,
  };
}

/**
 * Live totals per stream for these dates, kept APART per unit (kg and bags do not
 * add). With `me`, only the handovers that person can see are added — so the
 * totals always agree with the list on the same screen.
 */
export function wasteTotals(db: Database.Database, from: string, to: string, me?: SessionUser | null) {
  const vis = me ? p5VisibilityClause(me, 'w', 'recorded_by') : { sql: '', args: [] as any[] };
  const rows = db.prepare(
    `SELECT w.qty_uom AS uom, COUNT(*) AS n,
            SUM(w.wet_qty) AS wet, SUM(w.dry_qty) AS dry, SUM(w.other_qty) AS other,
            COUNT(w.wet_qty) AS wet_n, COUNT(w.dry_qty) AS dry_n, COUNT(w.other_qty) AS other_n
       FROM fssai_waste_handovers w
      WHERE w.status <> 'void' AND w.voided_at = '' AND w.business_date >= ? AND w.business_date <= ?
        ${vis.sql ? `AND ${vis.sql}` : ''}
      GROUP BY w.qty_uom ORDER BY w.qty_uom`,
  ).all(from, to, ...vis.args) as any[];
  return rows.map((r) => ({
    uom: String(r.uom || 'kg'),
    handovers: Number(r.n) || 0,
    // SUM over no rows is NULL — kept null, never shown as 0.
    wet: r.wet_n ? Math.round(Number(r.wet) * 100) / 100 : null,
    dry: r.dry_n ? Math.round(Number(r.dry) * 100) / 100 : null,
    other: r.other_n ? Math.round(Number(r.other) * 100) / 100 : null,
  }));
}

/**
 * THE DAYS WASTE DID NOT LEAVE — dates in [from, to] with no live handover.
 * Restaurant-wide on purpose: "did waste leave the building on the 9th" has one
 * answer whoever asks. Days before the log's first ever handover are reported
 * separately (`before_log`), so a log started last week does not read as a month
 * of missed collections.
 */
export function wasteDaysWithout(db: Database.Database, from: string, to: string, today: string = fssaiToday()) {
  const first = db.prepare(
    `SELECT MIN(business_date) AS d FROM fssai_waste_handovers WHERE status <> 'void' AND voided_at = ''`,
  ).get() as any;
  const firstEver = str(first?.d);
  const had = new Set((db.prepare(
    `SELECT DISTINCT business_date AS d FROM fssai_waste_handovers
      WHERE status <> 'void' AND voided_at = '' AND business_date >= ? AND business_date <= ?`,
  ).all(from, to) as any[]).map((r) => String(r.d)));
  const all = datesBetween(from, to);
  /* TODAY IS NOT A MISSED DAY YET — the truck may not have come. Only finished
   * days count; `today_pending` says the current one has nothing so far. */
  const without = all.filter((d) => d < today && !had.has(d) && firstEver && d >= firstEver);
  const beforeLog = all.filter((d) => !firstEver || d < firstEver).length;
  const todayPending = all.includes(today) && !had.has(today);
  return { first_ever: firstEver, days: all.length, days_with: had.size, without, before_log: beforeLog, today_pending: todayPending };
}

/** The last live handover anywhere, or null. */
export function lastWasteHandover(db: Database.Database) {
  const r = db.prepare(
    `${WASTE_SELECT} WHERE w.status <> 'void' AND w.voided_at = ''
      ORDER BY w.business_date DESC, w.handed_at DESC, w.created_at DESC, w.rowid DESC LIMIT 1`,
  ).get() as any;
  return r ? shapeWasteHandover(r) : null;
}

export type WasteStatus = 'present' | 'expiring' | 'missing';

/** PRESENT / EXPIRING / MISSING by WASTE_HANDOVER_CADENCE, with the reason in words. */
export function judgeWasteRegister(lastDate: string, today: string): { status: WasteStatus; age: number | null; problems: string[]; lapses_on: string } {
  if (!lastDate) {
    return { status: 'missing', age: null, problems: ['No waste handover has been recorded.'], lapses_on: '' };
  }
  const age = daysBetweenISO(lastDate, today);
  const c = WASTE_HANDOVER_CADENCE;
  if (!Number.isFinite(age) || age <= c.fresh) {
    return { status: 'present', age: Number.isFinite(age) ? age : 0, problems: [], lapses_on: addDaysISO(lastDate, c.fresh + 1) };
  }
  const said = `The last handover recorded was on ${lastDate} (${age} days ago). Waste is expected to leave ${c.words}.`;
  if (age <= c.stale) return { status: 'expiring', age, problems: [said], lapses_on: addDaysISO(lastDate, c.stale + 1) };
  return { status: 'missing', age, problems: [said], lapses_on: '' };
}

/** Recent collectors, newest first, for the one-tap "same as last time" pick. */
export function recentWasteCollectors(db: Database.Database, limit = 6) {
  const rows = db.prepare(
    `SELECT collector_kind, collector_name, vendor_id, agency_reg_no, vehicle_no, qty_uom,
            received_by_name, document_id, MAX(created_at) AS last_at
       FROM fssai_waste_handovers
      WHERE status <> 'void' AND voided_at = ''
      GROUP BY collector_kind, lower(collector_name), vendor_id
      ORDER BY last_at DESC LIMIT ?`,
  ).all(limit) as any[];
  return rows.map((r) => ({
    collector_kind: String(r.collector_kind || ''),
    collector_kind_label: wasteCollectorLabel(r.collector_kind),
    collector_name: String(r.collector_name || ''),
    vendor_id: String(r.vendor_id || ''),
    agency_reg_no: String(r.agency_reg_no || ''),
    vehicle_no: String(r.vehicle_no || ''),
    qty_uom: String(r.qty_uom || 'kg'),
    received_by_name: String(r.received_by_name || ''),
    document_id: String(r.document_id || ''),
  }));
}

/** Names that have handed waste over before — free text, may have no login. */
export function recentWasteHandlers(db: Database.Database, limit = 8): string[] {
  return (db.prepare(
    `SELECT handed_over_name AS n, MAX(created_at) AS last_at FROM fssai_waste_handovers
      WHERE status <> 'void' AND voided_at = '' AND handed_over_name <> ''
      GROUP BY lower(handed_over_name) ORDER BY last_at DESC LIMIT ?`,
  ).all(limit) as any[]).map((r) => String(r.n));
}

/** Live collector agreements filed under Documents & Certificates, for the optional link. */
export function wasteAgreements(db: Database.Database) {
  return (db.prepare(
    `SELECT id, title, reference_no, expiry_date FROM fssai_documents
      WHERE doc_type = ? AND status <> 'void' AND voided_at = ''
      ORDER BY created_at DESC LIMIT 50`,
  ).all(WASTE_AGREEMENT_DOC_TYPE) as any[]).map((d) => ({
    id: String(d.id), title: String(d.title || ''), reference_no: String(d.reference_no || ''), expiry_date: String(d.expiry_date || ''),
  }));
}

/* ------------------------------------------------------------------ *
 * FOR THE AUDIT FILE — record 14, "Waste disposal record"
 * ------------------------------------------------------------------ */

/** The same field names as the audit file's AuditFileRow/Table/Scan, defined here so nothing is imported from that lane. */
export interface WasteAuditRow { cells: string[]; href: string; tone: '' | 'bad' | 'warn'; in_handover: boolean }
export interface WasteAuditTable {
  title: string;
  columns: { label: string; width: number; align?: 'left' | 'right' }[];
  rows: WasteAuditRow[];
  more: number;
  handover_rows: number;
  empty: string;
}
export interface WasteAuditScan {
  attachment_id: string;
  entity_table: string;
  entity_id: string;
  record_label: string;
  filename: string;
  mime: string;
  size_bytes: number;
  caption: string;
  created_at: string;
  has_image: boolean;
  image_dropped_at: string;
}
export interface WasteAuditPart {
  status: WasteStatus;
  headline: string;
  problems: string[];
  todo: string;
  lapses_on: string;
  basis: string;
  links: { href: string; label: string }[];
  summary: { label: string; value: string; mgmt?: true }[];
  tables: WasteAuditTable[];
  scans: WasteAuditScan[];
  /** The live handovers in the period, shaped — for a caller that wants more than the table. */
  handovers: WasteHandoverView[];
}

/**
 * RECORD 14 OF THE AUDIT FILE, judged on the handover log.
 *
 * Call it with the audit file's own `today`, `since` (the first day listed) and
 * row limit. It reads only live handovers (voided and drafts are not filed
 * records), never writes, and returns the shape AuditFileItem uses minus n / key
 * / title. Status is by WASTE_HANDOVER_CADENCE on the LAST handover ever, not
 * only the ones in the period — a log that stopped yesterday is fresh whatever
 * window is being printed.
 *
 * Photographs are listed as scans only when ACTIVE (a voided receipt photo is
 * not a copy of the record; it stays visible on the log page as voided).
 */
export function wasteHandoverAuditPart(
  db: Database.Database,
  opts: { today: string; since: string; rowLimit?: number },
): WasteAuditPart {
  const links = [{ href: WASTE_PAGE, label: WASTE_PAGE_LABEL }];
  const basis =
    `From the ${WASTE_PAGE_LABEL}: one line per handover — date, wet / dry / other, quantity, collector (GHMC or agency), ` +
    `receipt or vehicle number, who handed it over. PRESENT while the last handover is at most ${WASTE_HANDOVER_CADENCE.fresh} days old, ` +
    `EXPIRING up to ${WASTE_HANDOVER_CADENCE.stale} days, MISSING after that or when none is recorded. Voided handovers are not counted.`;
  const todo = `Record each waste handover at the back door under ${WASTE_PAGE_LABEL} — what went, how much, who took it and the receipt or vehicle number.`;

  const exists = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(WASTE_TABLE);
  if (!exists) {
    return {
      status: 'missing', headline: 'Nothing on file', lapses_on: '', basis, links, todo,
      problems: [`The register this record is kept in (${WASTE_TABLE}) has not been created in this copy of the database yet. Restart the application once and it will be there.`],
      summary: [], tables: [], scans: [], handovers: [],
    };
  }

  const limit = Math.max(1, opts.rowLimit || 50);
  const since = isISODate(opts.since) ? opts.since : addDaysISO(opts.today, -30);
  const rows = (db.prepare(
    `${WASTE_SELECT}
      WHERE w.status <> 'void' AND w.voided_at = '' AND w.business_date >= ? AND w.business_date <= ?
      ORDER BY w.business_date DESC, w.handed_at DESC, w.created_at DESC, w.rowid DESC`,
  ).all(since, opts.today) as any[]).map(shapeWasteHandover);

  const last = lastWasteHandover(db);
  const verdict = judgeWasteRegister(last?.business_date || '', opts.today);
  const gaps = wasteDaysWithout(db, since, opts.today, opts.today);
  const noProof = rows.filter((r) => r.lacks_proof).length;
  const totals = wasteTotals(db, since, opts.today);

  const totalText = (k: 'wet' | 'dry' | 'other') => {
    const parts = totals.filter((t) => t[k] !== null).map((t) => wasteQtyText(t[k], t.uom));
    return parts.length ? parts.join(' + ') : '—';
  };

  const tableRows: WasteAuditRow[] = rows.map((r) => ({
    cells: [
      r.business_date + (r.handed_at ? ` ${r.handed_at}` : ''),
      r.handover_no,
      r.wet_text,
      r.dry_text,
      r.other_text ? `${r.other_text} (${r.other_kind})` : '',
      wasteCollectorText(r),
      [r.receipt_no ? `Rcpt ${r.receipt_no}` : '', r.vehicle_no ? `Veh ${r.vehicle_no}` : ''].filter(Boolean).join(' · ') || (r.note ? `Note: ${r.note}` : ''),
      r.handed_over_name,
    ],
    href: WASTE_PAGE,
    tone: r.lacks_proof ? 'warn' : '',
    in_handover: true,
  }));

  const photos = readWastePhotos(db, rows.map((r) => r.id));
  const scans: WasteAuditScan[] = [];
  for (const r of rows) {
    for (const p of photos.get(r.id) || []) {
      if (p.status === 'void' || p.voided_at) continue;
      scans.push({
        attachment_id: p.id, entity_table: WASTE_TABLE, entity_id: r.id,
        record_label: `Waste handover ${r.handover_no} · ${r.business_date}`,
        filename: p.filename, mime: p.mime, size_bytes: p.size_bytes, caption: p.caption,
        created_at: p.created_at, has_image: p.has_image && !p.image_dropped_at, image_dropped_at: p.image_dropped_at,
      });
    }
  }

  const headline = last
    ? `${rows.length} handover${rows.length === 1 ? '' : 's'} since ${since} · last on ${last.business_date} to ${last.vendor_name || last.collector_name}`
    : 'Nothing on file';

  return {
    status: verdict.status,
    headline,
    problems: verdict.problems,
    todo: verdict.status === 'present' ? '' : todo,
    lapses_on: verdict.lapses_on,
    basis,
    links,
    summary: [
      { label: 'Handovers', value: String(rows.length) },
      { label: 'Last handover', value: last?.business_date || '—' },
      { label: 'Wet', value: totalText('wet') },
      { label: 'Dry', value: totalText('dry') },
      { label: 'Other', value: totalText('other') },
      { label: 'Days with no handover', value: String(gaps.without.length), mgmt: true },
      { label: 'With no receipt or vehicle', value: String(noProof), mgmt: true },
    ],
    tables: [{
      title: `Waste handed over from ${since}`,
      columns: [
        { label: 'Date', width: 1 }, { label: 'No.', width: 1 },
        { label: 'Wet', width: 0.7, align: 'right' }, { label: 'Dry', width: 0.7, align: 'right' },
        { label: 'Other', width: 1.1 }, { label: 'Collector', width: 1.8 },
        { label: 'Receipt / vehicle', width: 1.4 }, { label: 'Handed over by', width: 1.1 },
      ],
      rows: tableRows.slice(0, limit),
      more: Math.max(0, tableRows.length - limit),
      handover_rows: tableRows.length,
      empty: 'No waste handover was recorded in these dates.',
    }],
    scans,
    handovers: rows,
  };
}

/* ------------------------------------------------------------------ *
 * Who may see one handover
 * ------------------------------------------------------------------ */

/** Row-level mirror of the list's visibility (the module's one rule). */
export function canSeeWasteHandover(me: SessionUser, row: any): boolean {
  if (isManagement(me)) return true;
  const mine = str(me.email).trim().toLowerCase();
  if (mine && str(row?.recorded_by).trim().toLowerCase() === mine) return true;
  const dept = str(row?.department_id);
  return !dept || dept === str(me.department_id);
}
