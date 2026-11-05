/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
import {
  fssaiVoidRefusal, isFssaiAttachmentPurpose, parseFssaiDataUri,
  FSSAI_ATTACHMENT_KINDS, FSSAI_ATTACHMENT_PURPOSES,
  type FssaiActor,
} from '@/lib/fssai';
import { fssaiAudit, fssaiAppAudit, str } from '@/lib/fssai-server';
import { FSSAI_ADMIN_MAY_VOID_OWN_RECORD } from '@/lib/fssai-void';
import { shapeP6Attachment, P6_ATTACHMENTS_PER_RECORD, type P6Attachment } from '../p6-shared';

/**
 * THE SCANS ON A DOCUMENT — written, listed and VOIDED here, for the documents
 * route only (/api/fssai/documents). The pest registers keep their own.
 *
 * ═══ DECISION (2026-10-14): A FILE ON A DOCUMENT IS VOIDED, NEVER STRIPPED ═══
 *
 * WHAT WAS MEASURED. The documents route's 'remove_file' called
 * dropP6AttachmentImage, which — even after the last round fixed the
 * cross-record hole — still BLANKED data_uri and stamped image_dropped_at: a
 * licence scan attached in the last 24 hours could be made to vanish by any
 * manager with a four-letter reason (reproduced on a scratch copy: data_uri 118
 * bytes → 0, status still 'active', no void row). Under the module's law —
 * evidence is VOIDED, NEVER DELETED (void row + reason + actor, kept and
 * visible) — and the owner's Q22 ruling (document scans are never auto-deleted),
 * blanking a scan is a deletion of evidence under another name.
 *
 * WHAT IT DOES NOW, refusing at the first rule that fails:
 *  1. THE FILE MUST BELONG TO THE DOCUMENT THE REQUEST NAMED — entity_table
 *     'fssai_documents' AND entity_id = that document. A file that exists on any
 *     OTHER record (another document, a pest visit, a temperature log) is answered
 *     exactly like a missing one (404), so the refusal does not say where the file
 *     really lives; the mismatch is logged with both ids.
 *  2. Management only, with a reason in words — fssaiVoidRefusal, the module's
 *     single §19 rule.
 *  3. Never the person who uploaded it, unless an admin (owner Q23, the same rule
 *     fssai-void.ts enforces for whole records; FSSAI_ADMIN_MAY_VOID_OWN_RECORD).
 *     The person who attached the wrong page is also the person with a motive to
 *     make the right page go away.
 *  4. Not on a VOIDED document: a voided document is closed evidence, files and
 *     all. A superseded version (is_active = 0) is history, and a mistaken file on
 *     it can still be marked — it stays there either way.
 *  5. Not twice (409) — the first reason stands.
 *  6. ONE TRANSACTION: status = 'void' + voided_at + voided_by + void_reason on the
 *     attachment, and an fssai_audit_log row ('attachment_void', fssaiAudit THROWS,
 *     so no trace means no void). data_uri, size_bytes, digest_sha256 and
 *     image_dropped_at are NEVER touched — the image stays in the row, is still
 *     served on the document, and is shown as VOID.
 *
 * There is no age limit, because nothing is destroyed: the old 24-hour window
 * existed only because the old removal destroyed the image.
 *
 * WHY THE DOCUMENTS ROUTE HAS ITS OWN WRITER. The shared insertP6Attachment
 * counts EVERY row toward the 8-file cap. Now that a mistaken file is voided and
 * stays, a document whose wrong page was voided could never take the right one.
 * Here the cap counts LIVE files (8), with an outer bound on all files (16) so a
 * row cannot grow without limit. The file rules themselves are not re-written:
 * parseFssaiDataUri (mime, size, shape) and shapeP6Attachment are the shared ones.
 */

export const DOC_FILES_LIVE_LIMIT = P6_ATTACHMENTS_PER_RECORD;
export const DOC_FILES_TOTAL_LIMIT = P6_ATTACHMENTS_PER_RECORD * 2;

export interface DocFile extends P6Attachment {
  purpose: string;
  purpose_label: string;
  status: 'active' | 'void';
  is_void: boolean;
  voided_at: string;
  voided_by: string;
  void_reason: string;
}

let attStatusKnown: boolean | null = null;
/** The void columns arrive with the 2026-10-14 schema; a pre-boot copy lacks them. */
function hasVoidColumns(db: Database.Database): boolean {
  if (attStatusKnown) return true;
  const ok = !!db.prepare(`SELECT 1 FROM pragma_table_xinfo('fssai_attachments') WHERE name = 'status'`).get();
  if (ok) attStatusKnown = true;
  return ok;
}

function shapeDocFile(row: any, withImage: boolean): DocFile {
  const base = shapeP6Attachment(row, { withImage });
  const status = str(row.status) === 'void' ? 'void' : 'active';
  const purpose = str(row.purpose);
  return {
    ...base,
    purpose,
    purpose_label: FSSAI_ATTACHMENT_PURPOSES.find((p) => p.key === purpose)?.label || purpose,
    status,
    is_void: status === 'void',
    voided_at: str(row.voided_at),
    voided_by: str(row.voided_by),
    void_reason: str(row.void_reason),
  };
}

/**
 * Every file on a set of documents — live AND voided, oldest first, grouped by
 * document. The image is read only when a screen asked for one record.
 */
export function documentFilesFor(
  db: Database.Database,
  docIds: string[],
  opts: { withImage?: boolean } = {},
): Map<string, DocFile[]> {
  const out = new Map<string, DocFile[]>();
  const ids = [...new Set(docIds.filter(Boolean))];
  if (!ids.length) return out;
  const voidCols = hasVoidColumns(db)
    ? 'purpose, status, voided_at, voided_by, void_reason'
    : `'' AS purpose, 'active' AS status, '' AS voided_at, '' AS voided_by, '' AS void_reason`;
  const cols = opts.withImage
    ? `*, (data_uri <> '') AS has_image_flag`
    : `id, entity_table, entity_id, kind, '' AS data_uri, (data_uri <> '') AS has_image_flag,
       filename, mime, size_bytes, caption, digest_sha256, image_dropped_at, created_by, created_at, ${voidCols}`;
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = db.prepare(
      `SELECT ${cols} FROM fssai_attachments
        WHERE entity_table = 'fssai_documents' AND entity_id IN (${chunk.map(() => '?').join(',')})
        ORDER BY created_at ASC, rowid ASC`,
    ).all(...chunk) as any[];
    for (const r of rows) {
      const k = String(r.entity_id);
      const list = out.get(k) || [];
      list.push(shapeDocFile(r, !!opts.withImage));
      out.set(k, list);
    }
  }
  return out;
}

/** Attach one scan to one document. The caller has checked the document exists, is live, and the gate. */
export function insertDocumentFile(
  db: Database.Database,
  p: {
    document_id: string; kind?: string; purpose?: string; data_uri: string; filename?: string; caption?: string;
    actor: { email?: string | null; name?: string | null }; outlet_id?: string;
  },
): { error: string; status: number } | { attachment: DocFile } {
  const docId = str(p.document_id);
  if (!docId) return { error: 'Which document is this scan for?', status: 400 };
  const purpose = str(p.purpose);
  if (!isFssaiAttachmentPurpose(purpose)) {
    return { error: 'That is not a reason a file can be on a record.', status: 400 };
  }
  const parsed = parseFssaiDataUri(p.data_uri);
  if (!parsed.ok) return { error: parsed.error, status: parsed.code === 'too_big' ? 413 : 400 };

  const live = hasVoidColumns(db)
    ? Number((db.prepare(
      `SELECT COUNT(*) AS n FROM fssai_attachments WHERE entity_table = 'fssai_documents' AND entity_id = ? AND status <> 'void'`,
    ).get(docId) as any)?.n) || 0
    : Number((db.prepare(
      `SELECT COUNT(*) AS n FROM fssai_attachments WHERE entity_table = 'fssai_documents' AND entity_id = ?`,
    ).get(docId) as any)?.n) || 0;
  if (live >= DOC_FILES_LIVE_LIMIT) {
    return {
      error: `This document already has ${DOC_FILES_LIVE_LIMIT} files on it, which is the limit. Void the wrong one (it stays, marked void) before adding another.`,
      status: 409,
    };
  }
  const all = Number((db.prepare(
    `SELECT COUNT(*) AS n FROM fssai_attachments WHERE entity_table = 'fssai_documents' AND entity_id = ?`,
  ).get(docId) as any)?.n) || 0;
  if (all >= DOC_FILES_TOTAL_LIMIT) {
    return {
      error: `This document holds ${all} files counting the voided ones, which is as many as one record may hold. File the paper again as a new document.`,
      status: 409,
    };
  }

  const kind = FSSAI_ATTACHMENT_KINDS.some((k) => k.key === str(p.kind)) ? str(p.kind) : 'certificate';
  const digest = createHash('sha256').update(Buffer.from(parsed.b64, 'base64')).digest('hex');
  const id = generateId();
  if (hasVoidColumns(db)) {
    db.prepare(
      `INSERT INTO fssai_attachments
         (id, entity_table, entity_id, kind, data_uri, filename, mime, size_bytes, caption, digest_sha256,
          created_by, outlet_id, purpose, status)
       VALUES (?, 'fssai_documents', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    ).run(
      id, docId, kind, String(p.data_uri), str(p.filename).slice(0, 180), parsed.mime, parsed.bytes,
      str(p.caption).slice(0, 400), digest, p.actor.email || '', p.outlet_id || '', purpose,
    );
  } else {
    db.prepare(
      `INSERT INTO fssai_attachments
         (id, entity_table, entity_id, kind, data_uri, filename, mime, size_bytes, caption, digest_sha256, created_by, outlet_id)
       VALUES (?, 'fssai_documents', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, docId, kind, String(p.data_uri), str(p.filename).slice(0, 180), parsed.mime, parsed.bytes,
      str(p.caption).slice(0, 400), digest, p.actor.email || '', p.outlet_id || '',
    );
  }
  // The DIGEST and size go in the trail, never the image.
  fssaiAudit(db, {
    entity_table: 'fssai_documents', entity_id: docId, action: 'attach', field: 'attachment',
    after: { attachment_id: id, kind, purpose, filename: str(p.filename), mime: parsed.mime, size_bytes: parsed.bytes, digest_sha256: digest },
    actor: p.actor, outlet_id: p.outlet_id,
  });
  const row = db.prepare(`SELECT *, (data_uri <> '') AS has_image_flag FROM fssai_attachments WHERE id = ?`).get(id) as any;
  return { attachment: shapeDocFile(row, true) };
}

/**
 * VOID ONE SCAN ON ONE DOCUMENT — the rules are in this file's header. Returns
 * the refusal in words, or the voided file (image still in it).
 * Synchronous: the caller may wrap it in its own transaction (nested = savepoint).
 */
export function voidDocumentFile(
  db: Database.Database,
  p: {
    document_id: string;
    attachment_id: string;
    reason: string;
    me: FssaiActor & { email?: string | null; name?: string | null };
    outlet_id?: string;
  },
): { error: string; status: number } | { voided: DocFile } {
  if (!hasVoidColumns(db)) {
    return { error: 'This database has not been upgraded to keep voided files yet. Restart the application once.', status: 409 };
  }
  const docId = str(p.document_id);
  const att = db.prepare(`SELECT * FROM fssai_attachments WHERE id = ?`).get(str(p.attachment_id)) as any;
  // RULE 1 — same answer for "no such file" and "not on THIS document".
  if (!att || !docId || String(att.entity_table) !== 'fssai_documents' || String(att.entity_id) !== docId) {
    if (att) {
      console.warn(
        `[fssai] void file refused: attachment ${att.id} is on ${att.entity_table}:${att.entity_id}, the request named fssai_documents:${docId || '(none)'} — by ${p.me?.email || 'unknown'}`,
      );
    }
    return { error: 'That file is not on this document.', status: 404 };
  }
  // RULE 2 — management + a reason in words.
  const refusal = fssaiVoidRefusal(p.me, { status: '', voided_at: '' }, p.reason);
  // A missing reason is the caller's to fix (400); anything else is who they are (403).
  if (refusal) return { error: refusal, status: /in words/i.test(refusal) ? 400 : 403 };
  // RULE 3 — never the uploader (admin excepted, Q23).
  const mine = str(p.me.email).trim().toLowerCase();
  const uploader = str(att.created_by).trim().toLowerCase();
  const selfVoid = !!(mine && uploader && mine === uploader);
  if (selfVoid && !(p.me.role === 'admin' && FSSAI_ADMIN_MAY_VOID_OWN_RECORD)) {
    return { error: 'You attached this file yourself, so somebody else has to void it — ask another manager or an administrator.', status: 403 };
  }
  // RULE 4 — the document itself.
  const doc = db.prepare(`SELECT id, status, voided_at FROM fssai_documents WHERE id = ?`).get(docId) as any;
  if (!doc) return { error: 'That file is not on this document.', status: 404 };
  if (str(doc.voided_at) || str(doc.status) === 'void') {
    return { error: 'This document has been voided, so it is closed evidence and its files stay exactly as they are.', status: 409 };
  }
  // RULE 5 — not twice.
  if (str(att.status) === 'void') return { error: 'That file has already been voided. The first reason stands.', status: 409 };

  // RULE 6 — the void and its trace, together or not at all. data_uri untouched.
  const reason = str(p.reason).trim().slice(0, 2000);
  const when = new Date().toISOString();
  let done = false;
  try {
    done = db.transaction(() => {
      const res = db.prepare(
        `UPDATE fssai_attachments
            SET status = 'void', voided_at = ?, voided_by = ?, void_reason = ?
          WHERE id = ? AND entity_table = 'fssai_documents' AND entity_id = ? AND status <> 'void'`,
      ).run(when, p.me.email || '', reason, att.id, docId);
      if (res.changes !== 1) return false;
      fssaiAudit(db, {
        entity_table: 'fssai_documents', entity_id: docId, action: 'attachment_void', field: 'attachment',
        before: {
          attachment_id: att.id, status: str(att.status) || 'active', filename: att.filename, mime: att.mime,
          size_bytes: att.size_bytes, digest_sha256: att.digest_sha256, created_at: att.created_at, created_by: att.created_by,
        },
        after: {
          attachment_id: att.id, status: 'void', voided_at: when, voided_by: p.me.email || '', void_reason: reason,
          // Restated so the trail itself proves the file was KEPT (file_kept is the
          // same key the pest registers write; image_kept says whether this row
          // still holds an image — false only for a row an earlier build blanked).
          file_kept: true, image_kept: str(att.data_uri) !== '', size_bytes: att.size_bytes, digest_sha256: att.digest_sha256,
          self_void: selfVoid,
        },
        reason, actor: { email: p.me.email, name: p.me.name }, outlet_id: p.outlet_id,
      });
      return true;
    })();
  } catch (e: any) {
    console.error('[fssai] void file rolled back — its trace could not be written:', e?.message);
    return { error: 'The void could not be recorded, so nothing was changed. The file is still live on the document.', status: 500 };
  }
  if (!done) return { error: 'That file has already been voided. The first reason stands.', status: 409 };

  fssaiAppAudit(db, {
    event_type: 'fssai.attachment.void', entity_type: 'fssai_documents', entity_id: docId,
    actor_email: p.me.email || '',
    before: { attachment_id: att.id, filename: att.filename, digest_sha256: att.digest_sha256 },
    after: { status: 'void', voided_at: when }, note: reason,
  });
  const after = db.prepare(`SELECT *, (data_uri <> '') AS has_image_flag FROM fssai_attachments WHERE id = ?`).get(att.id) as any;
  return { voided: shapeDocFile(after, false) };
}
