/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PEST CONTROL — THE FILES ON A VISIT OR A SIGHTING, AND HOW A WRONG ONE IS
 * TAKEN BACK. Used by /api/fssai/pest/services and /api/fssai/pest/sightings and
 * by nothing else.
 *
 * ═══ DECISION (2026-10-14): A FILE ON A PEST RECORD IS VOIDED, NEVER STRIPPED ═══
 *
 * WHAT WAS WRONG. The removal path these two routes used (dropP6AttachmentImage
 * in ../../p6-shared.ts) blanked fssai_attachments.data_uri and stamped
 * image_dropped_at. Within its 24-hour window a manager could therefore make a
 * contractor's job sheet or the photograph of a rat disappear from a filed
 * record — a deletion of evidence under another name. Reproduced on a scratch
 * copy of the database with HEAD's route code: the job sheet went from 118
 * characters of image to 0, and so did a sighting's photograph. Earlier still
 * (fixed in 0b1b4b6, re-proved here) the same call did not even check that the
 * file belonged to the record it named, so one request through the pest-visit
 * route could strip the scan off a licence in the documents register.
 *
 * WHAT IT DOES NOW. FSSAI law in this module is "void, never delete", and the
 * schema says it for this table in so many words (db.ts, table 26: "A file
 * attached by mistake is VOIDED … the row AND its image stay, shown as void …
 * nothing new may set [image_dropped_at] on this table"). So voidPestFile:
 *
 *   1. OWNERSHIP FIRST. The file must be on the record the request named — same
 *      table AND same id, read from the attachment row, never from the body.
 *      Anything else is answered exactly like a missing file (404), so the
 *      refusal does not tell the caller where the file really lives, and the
 *      attempt is logged with both addresses.
 *   2. Management only, with a reason in words — fssaiVoidRefusal, the module's
 *      single §19 rule, applied to the FILE row (so a second void is refused as
 *      "already voided" rather than overwriting the first reason).
 *   3. Never the person who attached it (Q23 — the person with the motive),
 *      except an administrator, for the reason fssai-void.ts gives: there is no
 *      tier above admin, so refusing him means his mistake can never be marked.
 *      Same constant, so the two rules cannot drift apart.
 *   4. Not on a voided record: a voided record is closed evidence, files and all.
 *   5. One transaction: status → 'void' with voided_at / voided_by /
 *      void_reason, and an fssai_audit_log row on the record (fssaiAudit throws,
 *      so a void that cannot be recorded does not happen). data_uri,
 *      image_dropped_at, size_bytes and digest_sha256 are NOT in the UPDATE — the
 *      file stays exactly as it was uploaded, and the screen shows it as void
 *      with its reason.
 *
 * WHY THERE IS NO TIME WINDOW ANY MORE. The 24 hours existed because the old
 * path destroyed something. A void destroys nothing: it is a visible, reasoned,
 * signed statement that sits beside the file for ever, so it may be made on a
 * two-year-old record as safely as on today's.
 *
 * WHY A VOIDED FILE STOPS COUNTING TOWARDS THE LIMIT. Eight active files per
 * record, as before (P6_ATTACHMENTS_PER_RECORD). If a voided file still used a
 * slot, a record holding eight files with one wrong one could never receive the
 * right one — the correction this path exists for. A hard ceiling of sixteen
 * rows, void or not, still bounds the record's size (16 × the 400 KB photo
 * ceiling).
 *
 * The documents register is NOT changed here — it belongs to another lane and
 * still calls p6-shared. Nothing in this file can touch a document's file:
 * PEST_FILE_TABLES is checked before any SQL.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
import {
  canManageFssaiCa, fssaiVoidRefusal, isFssaiAttachmentEntity, parseFssaiDataUri,
  FSSAI_ATTACHMENT_KINDS, type FssaiActor,
} from '@/lib/fssai';
import { fssaiAudit, fssaiAppAudit, str } from '@/lib/fssai-server';
import { FSSAI_ADMIN_MAY_VOID_OWN_RECORD } from '@/lib/fssai-void';
import { P6_ATTACHMENTS_PER_RECORD } from '../../p6-shared';

/** The two pest registers that carry files. Station checks do not: activity at
 *  a station raises a SIGHTING, and the photograph goes on the sighting. */
export const PEST_FILE_TABLES = ['fssai_pest_services', 'fssai_pest_sightings'] as const;
export type PestFileTable = (typeof PEST_FILE_TABLES)[number];

export const PEST_FILE_WORDS: Record<PestFileTable, string> = {
  fssai_pest_services: 'pest control visit',
  fssai_pest_sightings: 'pest sighting',
};

/** Active files a record may carry — unchanged from before. */
export const PEST_ACTIVE_FILES_PER_RECORD = P6_ATTACHMENTS_PER_RECORD;
/** Every row, void or not. Bounds the record's size once voids stop counting. */
export const PEST_FILES_HARD_CEILING = PEST_ACTIVE_FILES_PER_RECORD * 2;

export function isPestFileTable(v: unknown): v is PestFileTable {
  const s = String(v || '');
  // Both gates: the module-wide allowlist, then this lane's two tables.
  return isFssaiAttachmentEntity(s) && (PEST_FILE_TABLES as readonly string[]).includes(s);
}

export interface PestFile {
  id: string;
  entity_table: string;
  entity_id: string;
  kind: string;
  kind_label: string;
  /** '' on a list read (the image is fetched with one record), or on a legacy
   *  row an earlier build stripped (image_dropped_at says when). */
  data_uri: string;
  has_image: boolean;
  filename: string;
  mime: string;
  size_bytes: number;
  caption: string;
  digest_sha256: string;
  /** Legacy only — set by a build before 2026-10-14. Nothing writes it now. */
  image_dropped_at: string;
  purpose: string;
  status: 'active' | 'void';
  is_void: boolean;
  voided_at: string;
  voided_by: string;
  void_reason: string;
  created_by: string;
  created_at: string;
}

function kindLabel(kind: string): string {
  return FSSAI_ATTACHMENT_KINDS.find((k) => k.key === kind)?.label || kind || 'File';
}

export function shapePestFile(row: any, opts: { withImage?: boolean } = {}): PestFile {
  const uri = String(row.data_uri || '');
  const flag = row.has_image_flag;
  const isVoid = String(row.status || 'active') === 'void' || !!str(row.voided_at);
  return {
    id: String(row.id),
    entity_table: String(row.entity_table || ''),
    entity_id: String(row.entity_id || ''),
    kind: String(row.kind || 'photo'),
    kind_label: kindLabel(String(row.kind || 'photo')),
    data_uri: opts.withImage ? uri : '',
    // A list read selects '' AS data_uri on purpose, so "has an image" comes
    // from the computed flag, never from the blank (the trap p6-shared records).
    has_image: flag === undefined || flag === null ? !!uri : Number(flag) === 1,
    filename: String(row.filename || ''),
    mime: String(row.mime || ''),
    size_bytes: Number(row.size_bytes) || 0,
    caption: String(row.caption || ''),
    digest_sha256: String(row.digest_sha256 || ''),
    image_dropped_at: String(row.image_dropped_at || ''),
    purpose: String(row.purpose || ''),
    status: isVoid ? 'void' : 'active',
    is_void: isVoid,
    voided_at: String(row.voided_at || ''),
    voided_by: String(row.voided_by || ''),
    void_reason: String(row.void_reason || ''),
    created_by: String(row.created_by || ''),
    created_at: String(row.created_at || ''),
  };
}

/** Every file on a set of records — voided ones included, because they stay. */
export function pestFilesFor(
  db: Database.Database,
  table: PestFileTable,
  ids: string[],
  opts: { withImage?: boolean } = {},
): Map<string, PestFile[]> {
  const out = new Map<string, PestFile[]>();
  const list = ids.filter(Boolean);
  if (!list.length || !isPestFileTable(table)) return out;
  const cols = opts.withImage
    ? `*, (data_uri <> '') AS has_image_flag`
    : `id, entity_table, entity_id, kind, '' AS data_uri, (data_uri <> '') AS has_image_flag,
       filename, mime, size_bytes, caption, digest_sha256, image_dropped_at,
       purpose, status, voided_at, voided_by, void_reason, created_by, created_at`;
  const rows = db.prepare(
    `SELECT ${cols} FROM fssai_attachments
      WHERE entity_table = ? AND entity_id IN (${list.map(() => '?').join(',')})
      ORDER BY created_at ASC, rowid ASC`,
  ).all(table, ...list) as any[];
  for (const r of rows) {
    const k = String(r.entity_id);
    const arr = out.get(k) || [];
    arr.push(shapePestFile(r, opts));
    out.set(k, arr);
  }
  return out;
}

/**
 * Attach one file to one pest record. The caller has already loaded the record
 * and checked the person may write to it; this enforces the FILE: declared mime,
 * the 400 KB ceiling, the active and hard counts, a SHA-256 of the bytes at
 * upload, and an audit row (fssaiAudit throws — call inside a transaction).
 */
export function attachPestFile(
  db: Database.Database,
  p: {
    entity_table: PestFileTable;
    entity_id: string;
    kind?: string;
    data_uri: string;
    filename?: string;
    caption?: string;
    actor: { email?: string | null; name?: string | null };
    outlet_id?: string;
  },
): { error: string; status: number } | { attachment: PestFile } {
  if (!isPestFileTable(p.entity_table)) return { error: 'That is not a record this screen can attach a file to.', status: 400 };
  const entityId = str(p.entity_id);
  if (!entityId) return { error: 'Which record is this file for?', status: 400 };

  const parsed = parseFssaiDataUri(p.data_uri);
  if (!parsed.ok) return { error: parsed.error, status: parsed.code === 'too_big' ? 413 : 400 };

  const n = db.prepare(
    `SELECT SUM(CASE WHEN status <> 'void' AND voided_at = '' THEN 1 ELSE 0 END) AS active, COUNT(*) AS total
       FROM fssai_attachments WHERE entity_table = ? AND entity_id = ?`,
  ).get(p.entity_table, entityId) as any;
  const words = PEST_FILE_WORDS[p.entity_table];
  if ((Number(n?.active) || 0) >= PEST_ACTIVE_FILES_PER_RECORD) {
    return {
      error: `This ${words} already has ${PEST_ACTIVE_FILES_PER_RECORD} files on it, which is the limit. If one of them is wrong, a manager can void it with a reason — the voided file stays on the record, marked, and frees its place.`,
      status: 409,
    };
  }
  if ((Number(n?.total) || 0) >= PEST_FILES_HARD_CEILING) {
    return {
      error: `This ${words} already carries ${PEST_FILES_HARD_CEILING} files including voided ones, which is the most one record can hold. File the rest against a new record.`,
      status: 409,
    };
  }

  const kind = FSSAI_ATTACHMENT_KINDS.some((k) => k.key === str(p.kind)) ? str(p.kind) : 'photo';
  const digest = createHash('sha256').update(Buffer.from(parsed.b64, 'base64')).digest('hex');
  const id = generateId();
  db.prepare(
    `INSERT INTO fssai_attachments
       (id, entity_table, entity_id, kind, data_uri, filename, mime, size_bytes,
        caption, digest_sha256, created_by, outlet_id, purpose, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'active')`,
  ).run(
    id, p.entity_table, entityId, kind, String(p.data_uri),
    str(p.filename).slice(0, 180), parsed.mime, parsed.bytes,
    str(p.caption).slice(0, 400), digest, p.actor.email || '', p.outlet_id || '',
  );
  fssaiAudit(db, {
    entity_table: p.entity_table,
    entity_id: entityId,
    action: 'attach',
    field: 'attachment',
    after: { attachment_id: id, kind, filename: str(p.filename), mime: parsed.mime, size_bytes: parsed.bytes, digest_sha256: digest },
    actor: p.actor,
    outlet_id: p.outlet_id,
  });
  const row = db.prepare(`SELECT *, (data_uri <> '') AS has_image_flag FROM fssai_attachments WHERE id = ?`).get(id) as any;
  return { attachment: shapePestFile(row, { withImage: true }) };
}

/**
 * VOID one file on one pest record. The decision and its five rules are in this
 * file's header. Returns the refusal in words, or the voided file (image kept).
 * Opens its own transaction; better-sqlite3 nests it as a savepoint if the
 * caller already holds one.
 */
export function voidPestFile(
  db: Database.Database,
  p: {
    /** the attachment */
    id: string;
    /** THE RECORD THE REQUEST NAMED — the file must be on this one. */
    entity_table: PestFileTable;
    entity_id: string;
    reason: string;
    me: FssaiActor & { email?: string; name?: string };
    outlet_id?: string;
  },
): { error: string; status: number } | { voided: PestFile } {
  if (!isPestFileTable(p.entity_table)) return { error: 'That is not a record this screen can change a file on.', status: 400 };
  const entityId = str(p.entity_id);
  const row = db.prepare(`SELECT * FROM fssai_attachments WHERE id = ?`).get(str(p.id)) as any;

  // RULE 1 — ownership, and the same answer for "no such file" and "not here".
  if (!row || !entityId || String(row.entity_table) !== p.entity_table || String(row.entity_id) !== entityId) {
    if (row) {
      console.warn(
        `[fssai] pest file void refused: attachment ${row.id} is on ${row.entity_table}:${row.entity_id}, the request named ${p.entity_table}:${entityId || '(none)'} — by ${p.me?.email || 'unknown'}`,
      );
    }
    return { error: 'That file is not on this record.', status: 404 };
  }

  // RULE 2 — management, a reason in words, not already void.
  const refusal = fssaiVoidRefusal(p.me, { status: str(row.status), voided_at: str(row.voided_at) }, p.reason);
  if (refusal) {
    return {
      error: /already been voided/.test(refusal) ? 'That file has already been voided. The first reason stands.' : refusal,
      status: /already been voided/.test(refusal) ? 409 : 403,
    };
  }

  // RULE 3 — never the person who attached it, except an administrator.
  const mine = String(p.me.email || '').trim().toLowerCase();
  const uploader = String(row.created_by || '').trim().toLowerCase();
  const selfVoid = !!mine && !!uploader && mine === uploader;
  if (selfVoid && !(p.me.role === 'admin' && FSSAI_ADMIN_MAY_VOID_OWN_RECORD)) {
    return { error: 'You attached this file yourself, so somebody else must void it — ask another manager or an administrator.', status: 403 };
  }

  // RULE 4 — the record itself must exist and not be voided.
  const record = db.prepare(`SELECT id, status, voided_at FROM ${p.entity_table} WHERE id = ?`).get(entityId) as any;
  if (!record) return { error: 'That file is not on this record.', status: 404 };
  if (str(record.voided_at) || str(record.status) === 'void') {
    return { error: `This ${PEST_FILE_WORDS[p.entity_table]} has been voided, so it is closed evidence and its files stay as they are.`, status: 409 };
  }

  // RULE 5 — the void and its trace, together or not at all. data_uri is not
  // in this statement and never will be.
  const when = new Date().toISOString();
  const reason = str(p.reason).trim().slice(0, 2000);
  let done = false;
  try {
    done = db.transaction(() => {
      const res = db.prepare(
        `UPDATE fssai_attachments
            SET status = 'void', voided_at = ?, voided_by = ?, void_reason = ?
          WHERE id = ? AND entity_table = ? AND entity_id = ? AND status <> 'void' AND voided_at = ''`,
      ).run(when, p.me.email || '', reason, row.id, p.entity_table, entityId);
      if (res.changes !== 1) return false;   // voided by somebody else a moment ago
      fssaiAudit(db, {
        entity_table: p.entity_table,
        entity_id: entityId,
        action: 'attachment_void',
        field: 'attachment',
        before: {
          attachment_id: row.id, status: str(row.status) || 'active', filename: row.filename, mime: row.mime,
          size_bytes: row.size_bytes, digest_sha256: row.digest_sha256, created_at: row.created_at, created_by: row.created_by,
        },
        after: {
          attachment_id: row.id, status: 'void', voided_at: when, voided_by: p.me.email || '', void_reason: reason,
          // Restated so the log row itself proves the file was kept.
          file_kept: true, size_bytes: row.size_bytes, digest_sha256: row.digest_sha256, self_void: selfVoid,
        },
        reason,
        actor: { email: p.me.email, name: p.me.name },
        outlet_id: p.outlet_id,
      });
      return true;
    })();
  } catch (e: any) {
    console.error('[fssai] pest file void rolled back — its audit row could not be written:', e?.message);
    return { error: 'The void could not be recorded, so nothing changed. The file is still on the record as it was.', status: 500 };
  }
  if (!done) return { error: 'That file has already been voided. The first reason stands.', status: 409 };

  fssaiAppAudit(db, {
    event_type: 'fssai.attachment.void',
    entity_type: p.entity_table,
    entity_id: entityId,
    actor_email: p.me.email || '',
    before: { attachment_id: row.id, status: 'active', digest_sha256: row.digest_sha256 },
    after: { attachment_id: row.id, status: 'void', voided_at: when },
    note: reason,
  });
  const after = db.prepare(`SELECT *, (data_uri <> '') AS has_image_flag FROM fssai_attachments WHERE id = ?`).get(row.id) as any;
  return { voided: shapePestFile(after, { withImage: true }) };
}

/** May this person void a file on a pest record? (For the screen; the server
 *  re-checks everything in voidPestFile.) */
export function canVoidPestFiles(me: FssaiActor | null | undefined): boolean {
  return canManageFssaiCa(me);
}
