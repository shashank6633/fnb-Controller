/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
import {
  FSSAI_PHOTO_MIMES, fssaiDocType, fssaiVoidRefusal, isFssaiAttachmentEntity, parseFssaiDataUri,
  type FssaiActor, type FssaiAttachmentPurpose,
} from '@/lib/fssai';
import { fssaiAudit, fssaiAppAudit, str } from '@/lib/fssai-server';
import { fssaiTableExists } from '../_p9/lib';

/**
 * CLOSURE EVIDENCE — the Hyderabad audit checklist's line #120, "Previous audit
 * report and closure evidence" (docs/fssai/hyderabad-audit-checklist.json).
 *
 * ── WHAT WAS MISSING ────────────────────────────────────────────────────────
 * Closure was WORDS ONLY. A corrective action closed on `action_taken`, an
 * inspection point closed on `response`, and neither could carry a photograph.
 * An inspection visit had a `document_id` column for its report, but nothing on
 * the Inspection Reports page could set it and the route stored any string it
 * was sent — a dangling id read as "the report is linked". This file is the
 * one place those three gaps are closed, for the two routes that own the
 * records (/api/fssai/corrective-actions and /api/fssai/inspections).
 *
 * ── THE THREE RECORDS, AND WHY A FILE IS ON EACH ────────────────────────────
 *   fssai_corrective_actions   purpose 'closure' — the fix, photographed
 *   fssai_inspection_findings  purpose 'closure' — the point, fixed
 *   fssai_inspections          purpose 'report'  — the inspector's report itself
 * All three are already in FSSAI_ATTACHMENT_ENTITIES (the module-wide allowlist).
 * This file narrows to these three again, so a closure upload can never write a
 * file onto a temperature log or a licence that neither route permission-checked.
 *
 * ── VOID, NEVER DELETE — AND NEVER STRIP ────────────────────────────────────
 * A file attached by mistake is VOIDED: status 'void' + voided_at / voided_by /
 * void_reason, written with a status-guarded UPDATE and its fssai_audit_log rows
 * in ONE transaction. data_uri is never blanked and image_dropped_at is never
 * set — the row AND its image stay, shown as void. There is no DELETE in this
 * file and no UPDATE that names data_uri. Owner ruling Q22 (2026-10-14): files in
 * fssai_attachments are never auto-deleted either.
 *
 * ── FOR THE AUDIT-FILE LANE ─────────────────────────────────────────────────
 * readFssaiVisitClosureEvidence() is the read the audit file's record 20 should
 * call: per visit, the report copies (the linked document's live scans + the
 * visit's own live report files) and, per point, the live closure files from the
 * point AND from its corrective action — with voided files listed apart, so a
 * voided copy is never counted as a copy.
 *
 * better-sqlite3 is synchronous: nothing inside a db.transaction() here awaits.
 */

/* ══════════════════════════════════════════════════════════════════════════
 * 1. WHICH RECORDS, WHICH PURPOSE
 * ══════════════════════════════════════════════════════════════════════════ */

export const CLOSURE_ENTITY_TABLES = [
  'fssai_corrective_actions',
  'fssai_inspection_findings',
  'fssai_inspections',
] as const;
export type ClosureEntityTable = (typeof CLOSURE_ENTITY_TABLES)[number];

export function isClosureEntity(v: unknown): v is ClosureEntityTable {
  const s = String(v || '');
  // BOTH gates: the module-wide allowlist first, then this lane's three.
  return isFssaiAttachmentEntity(s) && (CLOSURE_ENTITY_TABLES as readonly string[]).includes(s);
}

/** The one purpose an upload to each record may carry. */
export const CLOSURE_PURPOSE_FOR: Record<ClosureEntityTable, Exclude<FssaiAttachmentPurpose, ''>> = {
  fssai_corrective_actions: 'closure',
  fssai_inspection_findings: 'closure',
  fssai_inspections: 'report',
};

export const CLOSURE_ENTITY_WORDS: Record<ClosureEntityTable, string> = {
  fssai_corrective_actions: 'corrective action',
  fssai_inspection_findings: 'inspection point',
  fssai_inspections: 'inspection',
};

/**
 * How many LIVE files one record may carry, and how many rows in all.
 *
 * Eight live, the same as the pest and documents registers (P6_ATTACHMENTS_PER_
 * RECORD) — a fix rarely needs more than a before, an after and a receipt. The
 * second cap counts voided rows too, because a void keeps its image: without
 * it, void-and-re-attach would grow one record without bound at 400 KB a time.
 */
export const CLOSURE_LIVE_FILES_PER_RECORD = 8;
export const CLOSURE_ALL_FILES_PER_RECORD = 16;

/** Where a screen opens one file. CA files through the CA route (its own fence). */
export function closureFileUrl(entityTable: string, attachmentId: string): string {
  const base = entityTable === 'fssai_corrective_actions' ? '/api/fssai/corrective-actions' : '/api/fssai/inspections';
  return `${base}?file=${encodeURIComponent(attachmentId)}`;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. READING FILES — metadata only; the image travels through ?file=
 * ══════════════════════════════════════════════════════════════════════════ */

export interface FssaiClosureFile {
  attachment_id: string;
  entity_table: string;
  entity_id: string;
  purpose: string;
  kind: string;
  filename: string;
  mime: string;
  size_bytes: number;
  caption: string;
  digest_sha256: string;
  created_by: string;
  created_at: string;
  /** false only for a row an earlier build blanked (image_dropped_at). */
  has_image: boolean;
  image_dropped_at: string;
  status: 'active' | 'void';
  voided_at: string;
  voided_by: string;
  void_reason: string;
  /** GET this to see the image. Void files still have one — a void keeps it. */
  url: string;
}

function s(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function shapeFile(r: any): FssaiClosureFile {
  const table = s(r.entity_table);
  return {
    attachment_id: s(r.id),
    entity_table: table,
    entity_id: s(r.entity_id),
    purpose: s(r.purpose),
    kind: s(r.kind) || 'photo',
    filename: s(r.filename),
    mime: s(r.mime),
    size_bytes: Number(r.size_bytes) || 0,
    caption: s(r.caption),
    digest_sha256: s(r.digest_sha256),
    created_by: s(r.created_by),
    created_at: s(r.created_at),
    has_image: Number(r.has_image) === 1,
    image_dropped_at: s(r.image_dropped_at),
    status: s(r.status) === 'void' ? 'void' : 'active',
    voided_at: s(r.voided_at),
    voided_by: s(r.voided_by),
    void_reason: s(r.void_reason),
    url: closureFileUrl(table, s(r.id)),
  };
}

const FILE_COLS = `id, entity_table, entity_id, purpose, kind, filename, mime, size_bytes, caption,
  digest_sha256, created_by, created_at, image_dropped_at, status, voided_at, voided_by, void_reason,
  (data_uri <> '') AS has_image`;

/**
 * Every file on a set of records of ONE table, live and void, grouped by record
 * id, oldest first. Never selects the image (a list must not ship 400 KB a row).
 * The table name is checked against an allowlist BEFORE it is bound — it is a
 * value here, never interpolated.
 */
export function listClosureFiles(
  db: Database.Database,
  entityTable: string,
  entityIds: string[],
): Map<string, FssaiClosureFile[]> {
  const out = new Map<string, FssaiClosureFile[]>();
  if (!isFssaiAttachmentEntity(entityTable) || !fssaiTableExists(db, 'fssai_attachments')) return out;
  const ids = [...new Set(entityIds.filter(Boolean).map(String))];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = db.prepare(
      `SELECT ${FILE_COLS} FROM fssai_attachments
        WHERE entity_table = ? AND entity_id IN (${chunk.map(() => '?').join(',')})
        ORDER BY created_at ASC, rowid ASC`,
    ).all(entityTable, ...chunk) as any[];
    for (const r of rows) {
      const f = shapeFile(r);
      const list = out.get(f.entity_id) || [];
      list.push(f);
      out.set(f.entity_id, list);
    }
  }
  return out;
}

/** Live files only, as a flat list, for one record. */
export function liveClosureFiles(db: Database.Database, entityTable: string, entityId: string): FssaiClosureFile[] {
  return (listClosureFiles(db, entityTable, [entityId]).get(entityId) || []).filter((f) => f.status === 'active');
}

/**
 * WHAT THE PERSON SAW — the live files on a record, by id and digest, frozen
 * into the audit row of a completion, a verification or a closure. Tomorrow's
 * void cannot change what yesterday's checker had in front of them.
 */
export function closureSnapshot(db: Database.Database, entityTable: string, entityId: string) {
  return liveClosureFiles(db, entityTable, entityId).map((f) => ({
    attachment_id: f.attachment_id, digest_sha256: f.digest_sha256, filename: f.filename,
    created_by: f.created_by, created_at: f.created_at, has_image: f.has_image,
  }));
}

/** Live file counts per record, for a list screen's camera badge. One query. */
export function liveClosureCounts(db: Database.Database, entityTable: string, entityIds: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isFssaiAttachmentEntity(entityTable) || !fssaiTableExists(db, 'fssai_attachments')) return out;
  const ids = [...new Set(entityIds.filter(Boolean).map(String))];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = db.prepare(
      `SELECT entity_id, COUNT(*) AS n FROM fssai_attachments
        WHERE entity_table = ? AND status = 'active' AND entity_id IN (${chunk.map(() => '?').join(',')})
        GROUP BY entity_id`,
    ).all(entityTable, ...chunk) as any[];
    for (const r of rows) out[s(r.entity_id)] = Number(r.n) || 0;
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. ATTACHING — one file per call (nginx's real 1 MB ceiling, HARD RULE 14)
 * ══════════════════════════════════════════════════════════════════════════ */

export interface ClosureAttachInput {
  entity_table: ClosureEntityTable;
  entity_id: string;
  data_uri: string;
  filename?: string;
  caption?: string;
  actor: { email?: string | null; name?: string | null };
  outlet_id?: string;
  /** A sentence for the audit row's reason — e.g. "Closure photograph for CA-2026-0004". */
  reason?: string;
}

/**
 * Attach ONE file to ONE record. Returns the refusal in words, or the new file.
 *
 * The CALLER must already have loaded the record, checked the person may write
 * to it, and checked the record's state allows a new file. This function cannot
 * know either; it enforces everything about the FILE: an allowlisted table, the
 * purpose that table takes, an image mime and the 400 KB ceiling
 * (parseFssaiDataUri — a data:text/html URI here would be stored XSS), the two
 * per-record caps, and a SHA-256 of the decoded bytes taken at upload.
 *
 * The insert and its two audit rows (one on the record, one on the attachment)
 * commit together or not at all — fssaiAudit throws by design.
 */
export function insertClosureFile(
  db: Database.Database,
  p: ClosureAttachInput,
): { error: string; status: number; code: string } | { file: FssaiClosureFile } {
  if (!isClosureEntity(p.entity_table)) {
    return { error: 'That is not a record this screen can attach a file to.', status: 400, code: 'bad_entity' };
  }
  const entityId = str(p.entity_id);
  if (!entityId) return { error: 'Which record is this photograph for?', status: 400, code: 'no_record' };
  if (!fssaiTableExists(db, 'fssai_attachments')) {
    return { error: 'Photographs are not available in this copy of the database yet. Restart the application once.', status: 503, code: 'no_table' };
  }

  const parsed = parseFssaiDataUri(p.data_uri);
  if (!parsed.ok) {
    return { error: parsed.error, status: parsed.code === 'too_big' ? 413 : 400, code: parsed.code };
  }

  const purpose = CLOSURE_PURPOSE_FOR[p.entity_table];
  const kind = purpose === 'report' ? 'report' : 'photo';
  const digest = createHash('sha256').update(Buffer.from(parsed.b64, 'base64')).digest('hex');
  const id = generateId();
  const words = CLOSURE_ENTITY_WORDS[p.entity_table];
  const actor = { email: p.actor.email || '', name: p.actor.name || '' };

  const tx = db.transaction(() => {
    // The caps are read INSIDE the transaction, so two uploads at the same
    // moment cannot both read "seven" and land a ninth.
    const c = db.prepare(
      `SELECT SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS live, COUNT(*) AS total
         FROM fssai_attachments WHERE entity_table = ? AND entity_id = ?`,
    ).get(p.entity_table, entityId) as any;
    if ((Number(c?.live) || 0) >= CLOSURE_LIVE_FILES_PER_RECORD) {
      return {
        error: `This ${words} already has ${CLOSURE_LIVE_FILES_PER_RECORD} photographs on it, which is the limit. Void one taken by mistake before adding another.`,
        status: 409, code: 'too_many',
      };
    }
    if ((Number(c?.total) || 0) >= CLOSURE_ALL_FILES_PER_RECORD) {
      return {
        error: `This ${words} has ${CLOSURE_ALL_FILES_PER_RECORD} photographs on file, voided ones included — voided files are kept, so they count. No more can be added to it.`,
        status: 409, code: 'too_many_total',
      };
    }
    db.prepare(
      `INSERT INTO fssai_attachments
         (id, entity_table, entity_id, kind, data_uri, filename, mime, size_bytes, caption,
          digest_sha256, created_by, outlet_id, purpose, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    ).run(
      id, p.entity_table, entityId, kind, String(p.data_uri).trim(),
      str(p.filename).slice(0, 180), parsed.mime, parsed.bytes, str(p.caption).slice(0, 400),
      digest, actor.email, p.outlet_id || '', purpose,
    );
    // The audit rows carry the DIGEST and the size, never the image.
    const after = {
      attachment_id: id, purpose, kind, filename: str(p.filename).slice(0, 180), caption: str(p.caption).slice(0, 400),
      mime: parsed.mime, size_bytes: parsed.bytes, digest_sha256: digest,
    };
    fssaiAudit(db, {
      entity_table: p.entity_table, entity_id: entityId, action: 'attach', field: 'attachment',
      after, reason: str(p.reason), actor, outlet_id: p.outlet_id,
    });
    fssaiAudit(db, {
      entity_table: 'fssai_attachments', entity_id: id, action: 'create',
      after: { ...after, entity_table: p.entity_table, entity_id: entityId },
      reason: str(p.reason), actor, outlet_id: p.outlet_id,
    });
    return null;
  });

  let refused: { error: string; status: number; code: string } | null = null;
  try {
    refused = tx();
  } catch (e: any) {
    console.error('[fssai] closure attach rolled back:', e?.message);
    return { error: 'The photograph could not be recorded, so nothing was saved. Try again.', status: 500, code: 'rolled_back' };
  }
  if (refused) return refused;

  fssaiAppAudit(db, {
    event_type: 'fssai.attachment.attach', entity_type: p.entity_table, entity_id: entityId,
    actor_email: actor.email, after: { attachment_id: id, purpose, digest_sha256: digest, size_bytes: parsed.bytes },
    note: str(p.reason),
  });
  const row = db.prepare(`SELECT ${FILE_COLS} FROM fssai_attachments WHERE id = ?`).get(id) as any;
  return { file: shapeFile(row) };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. VOIDING — the only way a file stops counting. It never leaves.
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * VOID ONE FILE ON ONE RECORD, with a reason. Returns the refusal, or the file.
 *
 * In order, refusing at the first rule that fails:
 *  1. THE FILE MUST BELONG TO THE RECORD THE REQUEST NAMED — same table, same
 *     id. A mismatch answers exactly like a missing file (404), so a refusal
 *     never tells a caller where a file really lives.
 *  2. The module's single §19 rule, fssaiVoidRefusal: management, a reason of at
 *     least four characters, not already void (409).
 *  3. The RECORD's state is the caller's — it passed the record it loaded and
 *     already decided whether files on it may still change.
 *  4. Then, in ONE transaction: a status-guarded UPDATE that sets the void trio
 *     and nothing else (data_uri and image_dropped_at are not in the statement),
 *     an audit row on the attachment and one on the record. No trace, no void.
 */
export function voidClosureFile(
  db: Database.Database,
  p: {
    attachment_id: string;
    entity_table: ClosureEntityTable;
    entity_id: string;
    reason: string;
    me: FssaiActor & { email?: string; name?: string };
    outlet_id?: string;
  },
): { error: string; status: number; code: string } | { file: FssaiClosureFile } {
  if (!isClosureEntity(p.entity_table)) {
    return { error: 'That is not a record this screen can change a file on.', status: 400, code: 'bad_entity' };
  }
  if (!fssaiTableExists(db, 'fssai_attachments')) {
    return { error: 'That file is not on this record.', status: 404, code: 'not_found' };
  }
  const entityId = str(p.entity_id);
  const row = db.prepare(`SELECT ${FILE_COLS} FROM fssai_attachments WHERE id = ?`).get(str(p.attachment_id)) as any;
  if (!row || !entityId || s(row.entity_table) !== p.entity_table || s(row.entity_id) !== entityId) {
    if (row) {
      console.warn(`[fssai] void_file refused: attachment ${row.id} is on ${row.entity_table}:${row.entity_id}, the request named ${p.entity_table}:${entityId || '(none)'} — by ${p.me?.email || 'unknown'}`);
    }
    return { error: 'That file is not on this record.', status: 404, code: 'not_found' };
  }
  const refusal = fssaiVoidRefusal(p.me, { status: s(row.status), voided_at: s(row.voided_at) }, p.reason);
  if (refusal) {
    const already = /already been voided/.test(refusal);
    return { error: already ? 'That photograph has already been voided.' : refusal, status: already ? 409 : 403, code: already ? 'already_void' : 'not_allowed' };
  }

  const when = new Date().toISOString();
  const reason = str(p.reason).slice(0, 2000);
  const actor = { email: p.me.email || '', name: (p.me as any).name || '' };
  const tx = db.transaction(() => {
    const res = db.prepare(
      `UPDATE fssai_attachments SET status = 'void', voided_at = ?, voided_by = ?, void_reason = ?
        WHERE id = ? AND entity_table = ? AND entity_id = ? AND status = 'active'`,
    ).run(when, actor.email, reason, row.id, p.entity_table, entityId);
    if (res.changes !== 1) return false;   // voided by somebody else a moment ago
    const before = {
      attachment_id: s(row.id), status: 'active', purpose: s(row.purpose), filename: s(row.filename),
      digest_sha256: s(row.digest_sha256), size_bytes: Number(row.size_bytes) || 0,
      created_by: s(row.created_by), created_at: s(row.created_at),
    };
    // The image is NOT touched, and the row says so — the proof is in the log.
    const after = { attachment_id: s(row.id), status: 'void', voided_at: when, voided_by: actor.email, image_kept: true, digest_sha256: s(row.digest_sha256) };
    fssaiAudit(db, {
      entity_table: 'fssai_attachments', entity_id: s(row.id), action: 'void',
      before, after, reason, actor, outlet_id: p.outlet_id,
    });
    fssaiAudit(db, {
      entity_table: p.entity_table, entity_id: entityId, action: 'attachment_void', field: 'attachment',
      before, after, reason, actor, outlet_id: p.outlet_id,
    });
    return true;
  });
  let done = false;
  try {
    done = tx();
  } catch (e: any) {
    console.error('[fssai] closure void rolled back — its trace could not be written:', e?.message);
    return { error: 'The void could not be recorded, so nothing changed. The photograph is still live on the record.', status: 500, code: 'rolled_back' };
  }
  if (!done) return { error: 'That photograph has already been voided.', status: 409, code: 'already_void' };

  fssaiAppAudit(db, {
    event_type: 'fssai.attachment.void', entity_type: p.entity_table, entity_id: entityId,
    actor_email: actor.email, before: { attachment_id: s(row.id), status: 'active' },
    after: { status: 'void' }, note: reason,
  });
  const after = db.prepare(`SELECT ${FILE_COLS} FROM fssai_attachments WHERE id = ?`).get(s(row.id)) as any;
  return { file: shapeFile(after) };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. SERVING ONE IMAGE — read-only, from an allowlist of types
 * ══════════════════════════════════════════════════════════════════════════ */

/** The attachment row a ?file= request names, or null. Caller fences it. */
export function readClosureFileRow(db: Database.Database, attachmentId: string): any | null {
  if (!attachmentId || !fssaiTableExists(db, 'fssai_attachments')) return null;
  return (db.prepare(
    `SELECT id, entity_table, entity_id, mime, filename, data_uri, image_dropped_at, status FROM fssai_attachments WHERE id = ?`,
  ).get(attachmentId) as any) || null;
}

/**
 * The image as a response. The Content-Type comes from FSSAI_PHOTO_MIMES, never
 * from the stored string as-is, and nosniff stops a browser second-guessing it.
 * A VOID file is served too — a void keeps its image, and hiding it would make
 * the void a deletion by another name. The screen marks it void.
 */
export function closureFileResponse(row: any): Response {
  const uri = s(row?.data_uri);
  if (!uri) {
    return Response.json(
      { error: `This file's image was removed${s(row?.image_dropped_at) ? ` on ${s(row.image_dropped_at).slice(0, 10)}` : ''} by an earlier build. The record of it — its size and fingerprint — remains.` },
      { status: 410 },
    );
  }
  const m = uri.match(/^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  const mime = m ? m[1].toLowerCase() : '';
  if (!m || !FSSAI_PHOTO_MIMES.includes(mime)) {
    return Response.json({ error: 'That file is not an image this screen can show.' }, { status: 415 });
  }
  const bytes = new Uint8Array(Buffer.from(m[2].replace(/\s+/g, ''), 'base64'));
  const safeName = (s(row.filename) || `photo-${s(row.id).slice(0, 8)}`).replace(/[^\w.\- ]+/g, '_').slice(0, 80);
  return new Response(bytes, {
    headers: {
      'Content-Type': mime,
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `inline; filename="${safeName}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6. THE VISIT'S REPORT DOCUMENT — fssai_inspections.document_id
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * The document types a visit's report may be filed as. 'audit_report' is the
 * authority's own line ("Previous audit report and closure evidence"); 'other'
 * is accepted because a report filed before that type existed must not have to
 * be re-filed. A licence or a pest contract linked as "the inspector's report"
 * is a mis-click, and is refused in words.
 */
export const REPORT_DOC_TYPES: readonly string[] = ['audit_report', 'other'];

export interface ReportDocument {
  id: string;
  title: string;
  reference_no: string;
  issuer: string;
  issued_on: string;
  doc_type: string;
  doc_type_label: string;
  status: string;
  is_active: boolean;
  voided: boolean;
  void_reason: string;
  /** Live scans with an image — a linked document with 0 is a title, not a copy. */
  live_scans: number;
  scans: FssaiClosureFile[];
}

function shapeDoc(db: Database.Database, d: any): ReportDocument {
  // A document's scans are served by /api/fssai/inspections?file= (management
  // only — the same gate as this screen); closureFileUrl points them there.
  const scans = listClosureFiles(db, 'fssai_documents', [s(d.id)]).get(s(d.id)) || [];
  return {
    id: s(d.id),
    title: s(d.title),
    reference_no: s(d.reference_no),
    issuer: s(d.issuer),
    issued_on: s(d.issued_on),
    doc_type: s(d.doc_type),
    doc_type_label: fssaiDocType(s(d.doc_type))?.label || s(d.doc_type),
    status: s(d.status),
    is_active: Number(d.is_active) === 1,
    voided: s(d.status) === 'void' || !!s(d.voided_at),
    void_reason: s(d.void_reason),
    live_scans: scans.filter((f) => f.status === 'active' && f.has_image).length,
    scans,
  };
}

/** One document by id, shaped, or null. */
export function readReportDocument(db: Database.Database, documentId: string): ReportDocument | null {
  if (!documentId || !fssaiTableExists(db, 'fssai_documents')) return null;
  const d = db.prepare(`SELECT * FROM fssai_documents WHERE id = ?`).get(documentId) as any;
  return d ? shapeDoc(db, d) : null;
}

/**
 * MAY THIS DOCUMENT BE LINKED AS A VISIT'S REPORT? '' when it may, else why not.
 * Exists, not voided, and filed as one of REPORT_DOC_TYPES.
 */
export function reportDocumentRefusal(db: Database.Database, documentId: string): { error: string; status: number } | null {
  if (!fssaiTableExists(db, 'fssai_documents')) {
    return { error: 'Documents are not available in this copy of the database yet.', status: 503 };
  }
  const d = db.prepare(`SELECT id, doc_type, title, status, voided_at FROM fssai_documents WHERE id = ?`).get(documentId) as any;
  if (!d) return { error: 'That document is not in Documents & Certificates. File the report there first, then link it here.', status: 400 };
  if (s(d.status) === 'void' || s(d.voided_at)) {
    return { error: `"${s(d.title)}" has been voided in Documents & Certificates, so it cannot stand as this visit's report.`, status: 409 };
  }
  if (!REPORT_DOC_TYPES.includes(s(d.doc_type))) {
    const label = fssaiDocType(s(d.doc_type))?.label || s(d.doc_type);
    return {
      error: `"${s(d.title)}" is filed as "${label}", not as an audit report. File the inspector's report under "Previous audit report and closure evidence" in Documents & Certificates, then link that.`,
      status: 400,
    };
  }
  return null;
}

/** The documents a visit could link, audit reports first. Live ones only. */
export function reportDocumentCandidates(db: Database.Database, limit = 100): ReportDocument[] {
  if (!fssaiTableExists(db, 'fssai_documents')) return [];
  const rows = db.prepare(
    `SELECT * FROM fssai_documents
      WHERE doc_type IN (${REPORT_DOC_TYPES.map(() => '?').join(',')})
        AND status <> 'void' AND voided_at = ''
      ORDER BY CASE doc_type WHEN 'audit_report' THEN 0 ELSE 1 END, issued_on DESC, created_at DESC
      LIMIT ?`,
  ).all(...REPORT_DOC_TYPES, limit) as any[];
  return rows.map((d) => shapeDoc(db, d));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 7. FOR THE AUDIT FILE — one visit's report and closure evidence, in full
 * ══════════════════════════════════════════════════════════════════════════ */

export interface FssaiFindingClosureEvidence {
  finding_id: string;
  finding_no: string;
  observation: string;
  severity: string;
  status: string;
  /** closed or not_accepted */
  settled: boolean;
  response: string;
  closed_at: string;
  closed_by: string;
  due_date: string;
  ca: {
    id: string; ca_number: string; status: string; action_taken: string;
    completed_by: string; completed_at: string; verified_by: string; verified_at: string;
  } | null;
  /** LIVE closure files — the point's own first, then its corrective action's. */
  closure_files: FssaiClosureFile[];
  /** Voided files, kept and listed apart. Never counted as evidence. */
  voided_files: FssaiClosureFile[];
  has_closure_photo: boolean;
}

export interface FssaiVisitClosureEvidence {
  inspection_id: string;
  inspection_no: string;
  business_date: string;
  status: string;
  report: {
    /** As stored on the visit. */
    document_id: string;
    /** null when nothing is linked or the id points at nothing. */
    document: ReportDocument | null;
    /** '' when the link is sound; otherwise the sentence to print. */
    document_problem: string;
    /** LIVE report files attached to the visit itself. */
    files: FssaiClosureFile[];
    voided_files: FssaiClosureFile[];
    /** Live images that are a copy of the report: the visit's own + the linked document's. */
    copies: number;
  };
  findings: FssaiFindingClosureEvidence[];
  counts: {
    findings: number;
    settled: number;
    /** settled points with at least one live closure photograph (point or CA) */
    settled_with_photo: number;
    settled_without_photo: number;
    open: number;
    report_copies: number;
  };
}

/**
 * readFssaiVisitClosureEvidence(db, inspectionIds) — THE FUNCTION THE AUDIT-FILE
 * LANE CALLS for record 20 ("Previous audit report and closure evidence").
 *
 * Read-only. For each visit id: the report (linked document + its live scans,
 * and the visit's own live report files; voided ones apart and never counted),
 * and every point with its live closure files from BOTH the point and the
 * corrective action it raised. Missing tables read as empty, never as a throw.
 */
export function readFssaiVisitClosureEvidence(
  db: Database.Database,
  inspectionIds: string[],
): Map<string, FssaiVisitClosureEvidence> {
  const out = new Map<string, FssaiVisitClosureEvidence>();
  const ids = [...new Set(inspectionIds.filter(Boolean).map(String))];
  if (!ids.length || !fssaiTableExists(db, 'fssai_inspections')) return out;

  const haveFindings = fssaiTableExists(db, 'fssai_inspection_findings');
  const haveCa = fssaiTableExists(db, 'fssai_corrective_actions');

  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const marks = chunk.map(() => '?').join(',');
    const visits = db.prepare(
      `SELECT id, inspection_no, business_date, status, document_id FROM fssai_inspections WHERE id IN (${marks})`,
    ).all(...chunk) as any[];
    const findings = haveFindings
      ? (db.prepare(
          `SELECT f.*, ${haveCa ? `ca.ca_number AS ca_number, ca.status AS ca_status, ca.action_taken AS ca_action_taken,
                  ca.completed_by AS ca_completed_by, ca.completed_at AS ca_completed_at,
                  ca.verified_by AS ca_verified_by, ca.verified_at AS ca_verified_at, ca.id AS ca_row_id`
                 : `NULL AS ca_row_id`}
             FROM fssai_inspection_findings f
             ${haveCa ? 'LEFT JOIN fssai_corrective_actions ca ON ca.id = f.ca_id' : ''}
            WHERE f.inspection_id IN (${marks})
            ORDER BY f.sort_order ASC, f.created_at ASC`,
        ).all(...chunk) as any[])
      : [];

    const visitFiles = listClosureFiles(db, 'fssai_inspections', visits.map((v) => s(v.id)));
    const findingFiles = listClosureFiles(db, 'fssai_inspection_findings', findings.map((f) => s(f.id)));
    const caFiles = listClosureFiles(db, 'fssai_corrective_actions', findings.map((f) => s(f.ca_row_id)).filter(Boolean));

    for (const v of visits) {
      const vid = s(v.id);
      const own = visitFiles.get(vid) || [];
      const docId = s(v.document_id);
      const doc = docId ? readReportDocument(db, docId) : null;
      let problem = '';
      if (docId && !doc) problem = 'The report linked to this visit is no longer in Documents & Certificates.';
      else if (doc && doc.voided) problem = `The linked report "${doc.title}" has been voided${doc.void_reason ? ` — ${doc.void_reason}` : ''}.`;
      else if (doc && !doc.live_scans) problem = `The linked report "${doc.title}" has no scan attached, so there is no copy to show.`;
      const files = own.filter((f) => f.status === 'active');
      const copies = files.filter((f) => f.has_image).length + (doc && !doc.voided ? doc.live_scans : 0);

      const fs = findings.filter((f) => s(f.inspection_id) === vid).map((f): FssaiFindingClosureEvidence => {
        const fid = s(f.id);
        const caId = s(f.ca_row_id);
        const all = [...(findingFiles.get(fid) || []), ...(caId ? caFiles.get(caId) || [] : [])];
        const live = all.filter((x) => x.status === 'active');
        return {
          finding_id: fid,
          finding_no: s(f.finding_no) || s(f.sort_order),
          observation: s(f.observation),
          severity: s(f.severity),
          status: s(f.status),
          settled: ['closed', 'not_accepted'].includes(s(f.status)),
          response: s(f.response),
          closed_at: s(f.closed_at),
          closed_by: s(f.closed_by),
          due_date: s(f.due_date),
          ca: caId
            ? {
                id: caId, ca_number: s(f.ca_number), status: s(f.ca_status), action_taken: s(f.ca_action_taken),
                completed_by: s(f.ca_completed_by), completed_at: s(f.ca_completed_at),
                verified_by: s(f.ca_verified_by), verified_at: s(f.ca_verified_at),
              }
            : null,
          closure_files: live,
          voided_files: all.filter((x) => x.status === 'void'),
          has_closure_photo: live.some((x) => x.has_image),
        };
      });
      const settled = fs.filter((f) => f.settled);
      out.set(vid, {
        inspection_id: vid,
        inspection_no: s(v.inspection_no),
        business_date: s(v.business_date),
        status: s(v.status),
        report: {
          document_id: docId,
          document: doc,
          document_problem: problem,
          files,
          voided_files: own.filter((f) => f.status === 'void'),
          copies,
        },
        findings: fs,
        counts: {
          findings: fs.length,
          settled: settled.length,
          settled_with_photo: settled.filter((f) => f.has_closure_photo).length,
          settled_without_photo: settled.filter((f) => !f.has_closure_photo).length,
          open: fs.length - settled.length,
          report_copies: copies,
        },
      });
    }
  }
  return out;
}

/** One visit's evidence, or null. */
export function readFssaiOneVisitClosureEvidence(db: Database.Database, inspectionId: string): FssaiVisitClosureEvidence | null {
  return readFssaiVisitClosureEvidence(db, [inspectionId]).get(inspectionId) || null;
}
