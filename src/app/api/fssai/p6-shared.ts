/**
 * P6 — PEST CONTROL (owner §7) and DOCUMENTS & CERTIFICATES (owner §17).
 * Server helpers shared by THIS LANE'S routes and nothing else.
 *
 * ── WHY THIS FILE IS HERE AND NOT IN src/lib ────────────────────────────────
 * Eight feature lanes are building the record modules in parallel and the
 * shared files (src/lib/db.ts, page-catalog.ts, Sidebar.tsx, fssai.ts) are
 * closed to all of them. src/lib/fssai-server.ts is shared too — it is read and
 * reused below, never edited. So the three things pest and documents genuinely
 * BOTH need (an attachment writer, a number allocator, one void rule) live here,
 * inside this lane's own API tree, where no sibling can collide with them.
 *
 * The trap this avoids has a name on this project: two lanes each wrote their
 * own sales-slice.ts with the same export signature, the pair disagreed
 * silently, and tsc pointed at the wrong one. Nothing in this file is exported
 * to anybody outside /api/fssai/pest and /api/fssai/documents. If a later phase
 * wants one of these helpers, it should be PROMOTED into fssai-server.ts
 * deliberately, by whoever owns that file, not imported from here.
 *
 * ── THE THREE RULES THIS FILE ENFORCES, SO FOUR ROUTES CANNOT DISAGREE ──────
 *  1. §19, void never delete. One refusal (fssaiVoidRefusal) and one writer
 *     (voidP6Record) for every register in this phase. No route holds a DELETE.
 *  2. A photograph or a scan goes into fssai_attachments, validated against
 *     FSSAI_ATTACHMENT_ENTITIES and then narrowed again to this lane's three
 *     tables — so a caller-supplied table name can neither reach SQL nor attach
 *     a file to another lane's record that this route never checked permission
 *     on. The entity row must EXIST first: an attachment pointing at nothing is
 *     an orphan no screen will ever show and the retention sweep would still
 *     carry.
 *  3. A corrective action is raised by writing fssai_corrective_actions ONCE,
 *     with run_id NULL (never '' — foreign_keys = ON makes '' throw), and the
 *     new id written back onto the record's ca_id so the link reads both ways.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
import {
  fssaiCaDueDate, fssaiToday, fssaiVoidRefusal, isFssaiCaSeverity,
  isFssaiAttachmentEntity, parseFssaiDataUri,
  FSSAI_ATTACHMENT_KINDS,
  type FssaiActor,
} from '@/lib/fssai';
import { fssaiAudit, fssaiAppAudit, str } from '@/lib/fssai-server';
import { fssaiManualRemovalRefusal, recordFssaiManualImageRemoval } from '@/lib/fssai-retention';

/* ------------------------------------------------------------------ *
 * 1. THE THREE TABLES THIS LANE OWNS
 * ------------------------------------------------------------------ */

/**
 * The records this lane may attach a file to and may void.
 *
 * A SUBSET of FSSAI_ATTACHMENT_ENTITIES, deliberately. That list is the whole
 * module's allowlist (fifteen tables); this one is the three rows these four
 * routes have actually checked the caller's permission against. Validating
 * against the wide list alone would let a pest-control POST attach a photograph
 * to a temperature log or an inspection finding — tables this route knows
 * nothing about and never gated.
 */
export const P6_ENTITY_TABLES = [
  'fssai_pest_services',
  'fssai_pest_sightings',
  'fssai_documents',
] as const;

export type P6EntityTable = (typeof P6_ENTITY_TABLES)[number];

export function isP6Entity(v: unknown): v is P6EntityTable {
  const s = String(v || '');
  // BOTH gates, in this order: the module-wide allowlist from the shared
  // vocabulary, then this lane's narrowing. If the shared list ever drops one
  // of these three, this returns false and the route refuses rather than
  // quietly writing to a table the module no longer recognises.
  return isFssaiAttachmentEntity(s) && (P6_ENTITY_TABLES as readonly string[]).includes(s);
}

/** The words a refusal uses for one of these rows. */
export const P6_ENTITY_WORDS: Record<P6EntityTable, string> = {
  fssai_pest_services: 'pest control visit',
  fssai_pest_sightings: 'pest sighting',
  fssai_documents: 'document',
};

/* ------------------------------------------------------------------ *
 * 2. ATTACHMENTS — the job sheet, the certificate scan, the photograph
 * ------------------------------------------------------------------ */

/**
 * How many files one record may carry.
 *
 * ASSUMPTION, REVERSIBLE (owner §7 Q13 — the 12-month in-row window he ruled on
 * caps the AGE of an image, not the COUNT). FSSAI_EVIDENCE_MAX_PER_ANSWER is 4,
 * which is right for one answer on a checklist; a pest contractor's job sheet
 * and a renewed licence both routinely run to several pages, so eight. At the
 * 400 KB server ceiling that is at most ~3.2 MB on the worst record.
 * ⚠️ These files are NOT cleared at twelve months: the retention sweep walks
 * checklist photographs only (§7 Q13), and whether register files ever age out
 * is Q22, unruled — see src/lib/fssai-retention.ts. So this cap is, for now, the
 * only bound on a record's size.
 */
export const P6_ATTACHMENTS_PER_RECORD = 8;

export interface P6Attachment {
  id: string;
  entity_table: string;
  entity_id: string;
  kind: string;
  kind_label: string;
  /** '' once retention has dropped the image. The ROW always survives. */
  data_uri: string;
  has_image: boolean;
  filename: string;
  mime: string;
  size_bytes: number;
  caption: string;
  digest_sha256: string;
  image_dropped_at: string;
  created_by: string;
  created_at: string;
}

function attachmentKindLabel(kind: string): string {
  return FSSAI_ATTACHMENT_KINDS.find((k) => k.key === kind)?.label || kind || 'File';
}

export function shapeP6Attachment(row: any, opts: { withImage?: boolean } = {}): P6Attachment {
  const uri = String(row.data_uri || '');
  /* ⚠️ has_image CANNOT BE DERIVED FROM data_uri ON A LIST READ, and this probe
   * caught it doing exactly that. A list deliberately SELECTs `'' AS data_uri`
   * so twenty 250 KB photographs do not travel down the wire to render twenty
   * filenames — which made `!!uri` false on every row, so every screen would
   * have shown the "image kept 12 months, then removed" placeholder for
   * photographs that are sitting right there in the database. The inert-guard
   * shape exactly: correct-looking code telling a food-safety screen a lie.
   * So the query carries a computed flag, and `!!uri` is only the fallback for
   * the SELECT * paths (insert, drop) where the column really is the truth. */
  const flag = row.has_image_flag;
  return {
    id: String(row.id),
    entity_table: String(row.entity_table || ''),
    entity_id: String(row.entity_id || ''),
    kind: String(row.kind || 'photo'),
    kind_label: attachmentKindLabel(String(row.kind || 'photo')),
    // A list of twenty documents must not ship twenty 250 KB data URIs down the
    // wire to render twenty filenames. The image comes back only when a screen
    // asked for one record.
    data_uri: opts.withImage ? uri : '',
    has_image: flag === undefined || flag === null ? !!uri : Number(flag) === 1,
    filename: String(row.filename || ''),
    mime: String(row.mime || ''),
    size_bytes: Number(row.size_bytes) || 0,
    caption: String(row.caption || ''),
    digest_sha256: String(row.digest_sha256 || ''),
    image_dropped_at: String(row.image_dropped_at || ''),
    created_by: String(row.created_by || ''),
    created_at: String(row.created_at || ''),
  };
}

/**
 * Every file on a set of records, grouped by record id.
 *
 * Without `withImage` this reads the metadata only — the data URI is the one
 * column in this table that is measured in hundreds of kilobytes, so a list
 * screen must never pull it.
 */
export function p6AttachmentsFor(
  db: Database.Database,
  entityTable: P6EntityTable,
  entityIds: string[],
  opts: { withImage?: boolean } = {},
): Map<string, P6Attachment[]> {
  const out = new Map<string, P6Attachment[]>();
  const ids = entityIds.filter((s) => !!s);
  if (!ids.length) return out;
  // Both branches carry has_image_flag, because the list branch blanks data_uri
  // on purpose and the shaper must not infer "no image" from that blank.
  const cols = opts.withImage
    ? `*, (data_uri <> '') AS has_image_flag`
    : `id, entity_table, entity_id, kind, '' AS data_uri, (data_uri <> '') AS has_image_flag,
       filename, mime, size_bytes, caption, digest_sha256, image_dropped_at,
       created_by, created_at`;
  // The id list is built from rows this route has already read, never from the
  // request body, and each placeholder is bound — no interpolation of a value.
  const marks = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT ${cols} FROM fssai_attachments
      WHERE entity_table = ? AND entity_id IN (${marks})
      ORDER BY created_at ASC, rowid ASC`,
  ).all(entityTable, ...ids) as any[];
  for (const r of rows) {
    const key = String(r.entity_id);
    const list = out.get(key) || [];
    list.push(shapeP6Attachment(r, opts));
    out.set(key, list);
  }
  return out;
}

export interface P6AttachInput {
  entity_table: P6EntityTable;
  entity_id: string;
  kind?: string;
  data_uri: string;
  filename?: string;
  caption?: string;
  actor: { email?: string | null; name?: string | null };
  outlet_id?: string;
}

/**
 * Attach one file to one record. Returns the refusal in words, or the new row.
 *
 * Caller MUST have already proved the entity row exists and that this person may
 * write to it — this function cannot know either. It does enforce everything
 * about the FILE: a declared mime, the 400 KB ceiling, the per-record count, and
 * a SHA-256 of the decoded bytes taken at upload so the digest outlives the
 * image the retention sweep will one day clear.
 *
 * ONE FILE PER CALL, always (the ceiling exists because production's nginx
 * client_max_body_size is 1 MB — HARD RULE 14 — and base64 is ~4/3 of the
 * bytes).
 */
export function insertP6Attachment(
  db: Database.Database,
  p: P6AttachInput,
): { error: string; status: number } | { attachment: P6Attachment } {
  if (!isP6Entity(p.entity_table)) {
    return { error: 'That is not a record this screen can attach a file to.', status: 400 };
  }
  const entityId = str(p.entity_id);
  if (!entityId) return { error: 'Which record is this file for?', status: 400 };

  const parsed = parseFssaiDataUri(p.data_uri);
  if (!parsed.ok) {
    // 413 for "too big", 400 for "not a photograph at all" — the code, never the
    // wording, decides, so improving the sentence cannot change the status.
    return { error: parsed.error, status: parsed.code === 'too_big' ? 413 : 400 };
  }

  const already = db.prepare(
    `SELECT COUNT(*) AS n FROM fssai_attachments WHERE entity_table = ? AND entity_id = ?`,
  ).get(p.entity_table, entityId) as any;
  if ((Number(already?.n) || 0) >= P6_ATTACHMENTS_PER_RECORD) {
    return {
      error: `This ${P6_ENTITY_WORDS[p.entity_table]} already has ${P6_ATTACHMENTS_PER_RECORD} files on it, which is the limit. Remove one before adding another.`,
      status: 409,
    };
  }

  const kind = FSSAI_ATTACHMENT_KINDS.some((k) => k.key === str(p.kind))
    ? str(p.kind)
    : 'photo';
  const digest = createHash('sha256').update(Buffer.from(parsed.b64, 'base64')).digest('hex');
  const id = generateId();

  db.prepare(
    `INSERT INTO fssai_attachments
       (id, entity_table, entity_id, kind, data_uri, filename, mime, size_bytes,
        caption, digest_sha256, created_by, outlet_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, p.entity_table, entityId, kind, String(p.data_uri),
    str(p.filename).slice(0, 180), parsed.mime, parsed.bytes,
    str(p.caption).slice(0, 400), digest,
    p.actor.email || '', p.outlet_id || '',
  );

  // The audit row records the DIGEST and the size, never the image: a compliance
  // trail that embedded a copy of every photograph would double the cost of the
  // thing the retention window exists to bound.
  fssaiAudit(db, {
    entity_table: p.entity_table,
    entity_id: entityId,
    action: 'attach',
    field: 'attachment',
    after: { attachment_id: id, kind, filename: str(p.filename), mime: parsed.mime, size_bytes: parsed.bytes, digest_sha256: digest },
    actor: p.actor,
    outlet_id: p.outlet_id,
  });

  const row = db.prepare(`SELECT * FROM fssai_attachments WHERE id = ?`).get(id) as any;
  return { attachment: shapeP6Attachment(row, { withImage: true }) };
}

/**
 * TAKE BACK A FILE ATTACHED BY MISTAKE — the only way an image leaves a filed
 * P6 record (the 12-month sweep does not walk fssai_attachments; see
 * src/lib/fssai-retention.ts and the Q22 note there).
 *
 * ═══ DECISION: A FILED RECORD'S FILE IS NOT REMOVABLE — EXCEPT A SAME-DAY ═══
 * ═══ CORRECTION, AND EVEN THAT IS A VOID, NOT A DELETE                     ═══
 *
 * A pest visit's job sheet, a sighting's photograph and a licence scan are
 * records an inspector can demand, and §19 is "void with a reason, never
 * delete". Adversarial verification found this function let a manager blank
 * ANY of them at ANY age with no retention row — and, because it never checked
 * that the file belonged to the record the request named, one call through the
 * pest-visit route could strip the scan off a LICENCE in the documents register.
 * What it does now, in order, refusing at the first rule that fails:
 *
 *  1. THE FILE MUST BELONG TO THE RECORD THE REQUEST NAMED — same table AND same
 *     id. The caller passes the record it has already loaded and
 *     permission-checked; a mismatch is answered exactly like a missing file
 *     (404), so the refusal does not tell a caller where the file really lives.
 *  2. Management only, with a reason in words (fssaiVoidRefusal, the module's
 *     single §19 rule) — the person who attached the wrong photograph of the
 *     right delivery is also the person with a motive to remove the right
 *     photograph of the wrong one, so the reason is kept for ever.
 *  3. Not on a VOIDED record: a voided record is closed evidence, files included.
 *  4. Only within FSSAI_FILE_CORRECTION_HOURS (24 h) of the upload, judged by
 *     fssaiManualRemovalRefusal — a file whose upload time is unreadable is
 *     refused, because it cannot be shown to be inside the window. After that
 *     the file stays; the remedies are to attach the right file beside it, or to
 *     void the record with a reason and file it again.
 *  5. Then, IN ONE TRANSACTION: blank data_uri and stamp image_dropped_at
 *     (size_bytes and digest_sha256 are left ALONE, so the file that was there
 *     stays provable — exactly what the sweep does), write fssai_audit_log
 *     (fssaiAudit throws), and write an fssai_retention_runs row
 *     (recordFssaiManualImageRemoval throws) so every image that ever leaves the
 *     file is in the same ledger as the sweep. No trace, no removal.
 */
export function dropP6AttachmentImage(
  db: Database.Database,
  p: {
    /** the attachment */
    id: string;
    /** THE RECORD THE REQUEST NAMED — the file must be on this one. */
    entity_table: P6EntityTable;
    entity_id: string;
    reason: string;
    me: FssaiActor & { email?: string; name?: string };
    outlet_id?: string;
    /** injectable for proofs; the server clock otherwise */
    now?: Date;
  },
): { error: string; status: number } | { dropped: P6Attachment } {
  if (!isP6Entity(p.entity_table)) {
    return { error: 'That is not a record this screen can remove a file from.', status: 400 };
  }
  const entityId = str(p.entity_id);
  const row = db.prepare(`SELECT * FROM fssai_attachments WHERE id = ?`).get(str(p.id)) as any;
  // RULE 1 — same answer for "no such file" and "not on THIS record".
  if (!row || !entityId || String(row.entity_table) !== p.entity_table || String(row.entity_id) !== entityId) {
    if (row) {
      console.warn(
        `[fssai] remove_file refused: attachment ${row.id} is on ${row.entity_table}:${row.entity_id}, the request named ${p.entity_table}:${entityId || '(none)'} — by ${p.me?.email || 'unknown'}`,
      );
    }
    return { error: 'That file is not on this record.', status: 404 };
  }
  if (str(row.image_dropped_at)) {
    return { error: 'That file has already been removed from this record.', status: 409 };
  }
  // RULE 2 — fssaiVoidRefusal is the module's single §19 rule (tier + reason).
  const refusal = fssaiVoidRefusal(p.me, { status: '', voided_at: '' }, p.reason);
  if (refusal) return { error: refusal, status: 403 };

  // RULE 3 — the record itself. The table name was checked by isP6Entity above,
  // so it is one of three literals before it is interpolated.
  const record = db.prepare(`SELECT id, status, voided_at FROM ${p.entity_table} WHERE id = ?`).get(entityId) as any;
  if (!record) return { error: 'That file is not on this record.', status: 404 };
  if (str(record.voided_at) || str(record.status) === 'void') {
    return {
      error: `This ${P6_ENTITY_WORDS[p.entity_table]} has been voided, so it is closed evidence and its files stay with it.`,
      status: 409,
    };
  }

  // RULE 4 — the correction window.
  const late = fssaiManualRemovalRefusal(row.created_at, p.now ?? new Date());
  if (late) return { error: late, status: 409 };

  // RULE 5 — the image, the audit row and the ledger row, together or not at all.
  const when = (p.now ?? new Date()).toISOString();
  const remove = db.transaction(() => {
    const res = db.prepare(
      `UPDATE fssai_attachments SET data_uri = '', image_dropped_at = ?
        WHERE id = ? AND entity_table = ? AND entity_id = ? AND data_uri <> ''`,
    ).run(when, row.id, p.entity_table, entityId);
    if (res.changes !== 1) return false;   // removed by somebody else a moment ago
    const ledgerId = recordFssaiManualImageRemoval(db, {
      store: 'fssai_attachments',
      file_id: String(row.id),
      of_words: P6_ENTITY_WORDS[p.entity_table],
      of_table: p.entity_table,
      of_id: entityId,
      filename: str(row.filename),
      size_bytes: Number(row.size_bytes) || 0,
      digest_sha256: str(row.digest_sha256),
      created_at: str(row.created_at),
      created_by: str(row.created_by),
      reason: str(p.reason),
      actor: { email: p.me.email, name: (p.me as any).name },
      outlet_id: p.outlet_id,
    });
    fssaiAudit(db, {
      entity_table: p.entity_table,
      entity_id: entityId,
      action: 'attachment_removed',
      field: 'attachment',
      before: {
        attachment_id: row.id, filename: row.filename, mime: row.mime, size_bytes: row.size_bytes,
        digest_sha256: row.digest_sha256, created_at: row.created_at, created_by: row.created_by,
        had_image: true,
      },
      after: {
        attachment_id: row.id, had_image: false, image_dropped_at: when,
        // Unchanged, restated so the log row proves they were unchanged.
        size_bytes: row.size_bytes, digest_sha256: row.digest_sha256,
        retention_run_id: ledgerId,
      },
      reason: str(p.reason),
      actor: { email: p.me.email, name: (p.me as any).name },
      outlet_id: p.outlet_id,
    });
    return true;
  });
  let removed = false;
  try {
    removed = remove();
  } catch (e: any) {
    // The ledger row or the audit row could not be written, so the transaction
    // rolled back and the image is still there. Said in words, not as SQLite's.
    console.error('[fssai] remove_file rolled back — its trace could not be written:', e?.message);
    return { error: 'The removal could not be recorded, so nothing was removed. The file is still on the record.', status: 500 };
  }
  if (!removed) return { error: 'That file has already been removed from this record.', status: 409 };

  fssaiAppAudit(db, {
    event_type: 'fssai.attachment.remove',
    entity_type: p.entity_table,
    entity_id: entityId,
    actor_email: p.me.email || '',
    before: { attachment_id: row.id, filename: row.filename, digest_sha256: row.digest_sha256 },
    after: { image_dropped_at: when },
    note: str(p.reason),
  });
  const after = db.prepare(`SELECT * FROM fssai_attachments WHERE id = ?`).get(row.id) as any;
  return { dropped: shapeP6Attachment(after) };
}

/* ------------------------------------------------------------------ *
 * 3. HUMAN-FACING NUMBERS
 * ------------------------------------------------------------------ */

/**
 * The next 'PST-2026-0001'.
 *
 * PEST VISITS ONLY, and the narrowness is deliberate. fssai_documents has a
 * doc_code column with its own partial UNIQUE index, but this lane does NOT
 * allocate one: doc_code is the STABLE key for a seeded or well-known document
 * (db.ts says so in its own comment), which makes it P8's namespace, and a
 * renewal cannot reuse its predecessor's code anyway because the index is unique
 * on (outlet_id, doc_code). A document the owner types in gets '' and is
 * identified by its title and reference_no. See the documents route.
 *
 * The house allocator (purchases/route.ts:587, nextFssaiCaNumber): MAX of the
 * numeric tail inside the year's prefix. MUST be called inside the caller's
 * transaction so two visits recorded at the same moment cannot read the same
 * MAX — and the partial UNIQUE index (uq_fssai_pest_service_no,
 * uq_fssai_doc_code) is the backstop if they ever do.
 *
 * The column name is NOT caller data: it is passed by this lane's own routes
 * from the two literals below, never from a request body.
 */
export function nextP6Number(
  db: Database.Database,
  opts: { table: 'fssai_pest_services'; column: 'service_no'; prefix: string; isoDate: string },
): string {
  const year = /^\d{4}-/.test(str(opts.isoDate)) ? str(opts.isoDate).slice(0, 4) : String(new Date().getFullYear());
  const like = `${opts.prefix}-${year}-`;
  const row = db.prepare(
    `SELECT MAX(CAST(substr(${opts.column}, length(?) + 1) AS INTEGER)) AS n
       FROM ${opts.table} WHERE ${opts.column} LIKE ? || '%'`,
  ).get(like, like) as any;
  return `${like}${String((Number(row?.n) || 0) + 1).padStart(4, '0')}`;
}

/* ------------------------------------------------------------------ *
 * 4. VOID — one writer for all three registers (§19)
 * ------------------------------------------------------------------ */

/**
 * Void one P6 record with a reason. Returns the refusal in words, or ''.
 *
 * The UPDATE names the table from P6_ENTITY_TABLES and nothing else — the
 * `table` argument is checked by isP6Entity BEFORE it is interpolated, so a
 * caller-supplied string cannot reach SQL. Every column written here exists on
 * all three tables (status, voided_at, voided_by, void_reason, updated_at),
 * which is why one writer is possible at all.
 */
export function voidP6Record(
  db: Database.Database,
  p: {
    table: P6EntityTable;
    id: string;
    reason: string;
    me: FssaiActor & { email?: string; name?: string };
    outlet_id?: string;
  },
): { error: string; status: number } | { voided: any } {
  if (!isP6Entity(p.table)) return { error: 'That is not a record this screen can cancel.', status: 400 };
  const row = db.prepare(`SELECT * FROM ${p.table} WHERE id = ?`).get(str(p.id)) as any;
  if (!row) return { error: `That ${P6_ENTITY_WORDS[p.table]} no longer exists.`, status: 404 };

  const refusal = fssaiVoidRefusal(p.me, { status: row.status, voided_at: row.voided_at }, p.reason);
  if (refusal) {
    return { error: refusal, status: /already been voided/.test(refusal) ? 409 : 403 };
  }
  // The person who wrote it may not void it (§19 / §7 Q23, as W1 built it). The
  // shared refusal above cannot test this — it does not know which column holds
  // the author on this table — so it is tested here, per table, by name.
  const author = String(
    p.table === 'fssai_pest_sightings' ? row.reported_by : row.created_by,
  ).trim().toLowerCase();
  const mine = String(p.me.email || '').trim().toLowerCase();
  if (author && mine && author === mine) {
    return {
      error: `You recorded this ${P6_ENTITY_WORDS[p.table]}, so somebody else must cancel it. Ask another manager or an administrator.`,
      status: 403,
    };
  }

  const when = new Date().toISOString();
  db.prepare(
    `UPDATE ${p.table}
        SET status = 'void', voided_at = ?, voided_by = ?, void_reason = ?, updated_at = ?
      WHERE id = ?`,
  ).run(when, p.me.email || '', str(p.reason), when, row.id);

  fssaiAudit(db, {
    entity_table: p.table,
    entity_id: String(row.id),
    action: 'void',
    before: { status: row.status },
    after: { status: 'void', voided_at: when, voided_by: p.me.email || '' },
    reason: str(p.reason),
    actor: { email: p.me.email, name: (p.me as any).name },
    outlet_id: p.outlet_id,
  });
  fssaiAppAudit(db, {
    event_type: 'fssai_void',
    entity_type: p.table,
    entity_id: String(row.id),
    actor_email: p.me.email || '',
    before: { status: row.status },
    after: { status: 'void' },
    note: str(p.reason),
  });

  const after = db.prepare(`SELECT * FROM ${p.table} WHERE id = ?`).get(row.id) as any;
  return { voided: after };
}

/* ------------------------------------------------------------------ *
 * 5. RAISING A CORRECTIVE ACTION FROM A P6 RECORD
 * ------------------------------------------------------------------ */

/**
 * Raise ONE corrective action against a pest sighting or a missed visit, and
 * write its id back onto the record.
 *
 * ── WHY THIS WRITES fssai_corrective_actions DIRECTLY ───────────────────────
 * /api/fssai/corrective-actions deliberately has no create: every action in the
 * file so far was raised by a failed checklist answer, inside the submit
 * transaction. A rat in the dry store is not a checklist answer and never will
 * be, and §7's whole point is that a sighting becomes something somebody closes
 * rather than something somebody mentions. So the row is inserted here, with the
 * SAME columns the engine's raiser sets, and from then on it is the CA route's —
 * assign, start, complete, verify, cancel all work on it unchanged, because the
 * CA SELECT joins fssai_runs with a LEFT JOIN and shapes a run-less action as
 * `run: null`.
 *
 * ── THE TWO THINGS THAT WOULD HAVE GONE WRONG ──────────────────────────────
 *  · run_id is NULL, never ''. foreign_keys = ON and the column carries an FK to
 *    fssai_runs, so '' throws — measured on this project and written into the
 *    lane brief.
 *  · source_kind is 'manual', which is one of the five values db.ts declares
 *    (run|response|temperature|inspection|manual). A 'pest' value would read
 *    better on a report and there is no CHECK constraint to stop it — but the
 *    vocabulary that would have to declare it lives in src/lib/fssai.ts, which
 *    this lane may not edit, and inventing an undeclared value beside a declared
 *    one is exactly the drift the shared-file rule exists to prevent. Recorded
 *    as an open problem instead: it is a one-line addition for whoever owns that
 *    file, and 'manual' is honest in the meantime — a person really did press a
 *    button to raise this.
 *
 * ASSUMPTION, REVERSIBLE: raising is MANUAL, never automatic. A sighting does
 * not raise an action by itself even at 'Infestation' severity, because the
 * action needs an owner and a date that only a person can choose, and an
 * auto-raised action with nobody's name on it is the inert row this module has
 * been bitten by four times. The screen pushes hard towards raising one; it does
 * not do it unasked.
 */
export interface P6RaiseCaInput {
  table: P6EntityTable;
  entity_id: string;
  title: string;
  description?: string;
  severity?: string;
  owner_email: string;
  department_id?: string;
  business_date: string;
  me: { email?: string | null; name?: string | null };
  outlet_id?: string;
  /** Allocated by the caller inside the same transaction. */
  ca_number: string;
}

export function raiseP6CorrectiveAction(
  db: Database.Database,
  p: P6RaiseCaInput,
): { error: string; status: number } | { ca_id: string; ca_number: string; due_date: string } {
  if (!isP6Entity(p.table)) return { error: 'That record cannot raise a corrective action.', status: 400 };
  const owner = str(p.owner_email).toLowerCase();
  if (!owner) return { error: 'Who is going to deal with this? A corrective action with nobody’s name on it is never closed.', status: 400 };
  const title = str(p.title).slice(0, 300);
  if (title.length < 4) return { error: 'Say in a line what has to be done.', status: 400 };

  const severity = isFssaiCaSeverity(p.severity) ? String(p.severity) : 'high';
  const businessDate = /^\d{4}-\d{2}-\d{2}$/.test(str(p.business_date)) ? str(p.business_date) : fssaiToday();
  const dueDate = fssaiCaDueDate(severity, businessDate);
  const caId = generateId();

  db.prepare(
    `INSERT INTO fssai_corrective_actions
       (id, ca_number, source_kind, run_id, response_id, equipment_id, department_id,
        title, description, severity, status, owner_email, due_date, created_by, outlet_id)
     VALUES (?, ?, 'manual', NULL, '', '', ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
  ).run(
    caId, str(p.ca_number), str(p.department_id),
    title, str(p.description).slice(0, 4000), severity,
    owner, dueDate, p.me.email || '', p.outlet_id || '',
  );

  // Both directions of the link, in the same transaction as the insert: the
  // action names the record in its description, the record names the action in
  // ca_id. A one-way link is how a sighting ends up with a fix nobody can find.
  db.prepare(`UPDATE ${p.table} SET ca_id = ?, updated_at = ? WHERE id = ?`)
    .run(caId, new Date().toISOString(), str(p.entity_id));

  fssaiAudit(db, {
    entity_table: p.table,
    entity_id: str(p.entity_id),
    action: 'raise_ca',
    field: 'ca_id',
    before: { ca_id: '' },
    after: { ca_id: caId, ca_number: str(p.ca_number), severity, owner_email: owner, due_date: dueDate },
    actor: p.me,
    outlet_id: p.outlet_id,
  });
  fssaiAudit(db, {
    entity_table: 'fssai_corrective_actions',
    entity_id: caId,
    action: 'create',
    after: { ca_number: str(p.ca_number), source: p.table, source_id: str(p.entity_id), severity, owner_email: owner, due_date: dueDate },
    actor: p.me,
    outlet_id: p.outlet_id,
  });

  return { ca_id: caId, ca_number: str(p.ca_number), due_date: dueDate };
}

/** The next CA number, same allocator the engine uses. */
export function nextP6CaNumber(db: Database.Database, isoDate: string): string {
  const year = /^\d{4}-/.test(str(isoDate)) ? str(isoDate).slice(0, 4) : String(new Date().getFullYear());
  const last = db.prepare(
    `SELECT MAX(CAST(substr(ca_number, length('CA-' || ? || '-') + 1) AS INTEGER)) AS n
       FROM fssai_corrective_actions WHERE ca_number LIKE 'CA-' || ? || '-%'`,
  ).get(year, year) as any;
  return `CA-${year}-${String((Number(last?.n) || 0) + 1).padStart(4, '0')}`;
}

/* ------------------------------------------------------------------ *
 * 6. SMALL SHARED BITS
 * ------------------------------------------------------------------ */

/** An ISO date, or '' — never today's date as a silent substitute. */
export function isoDateOrBlank(v: unknown): string {
  const s = str(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/**
 * An ISO timestamp, or ''.
 *
 * Accepts a date-only string and a full timestamp, because a phone's
 * <input type="datetime-local"> sends 'YYYY-MM-DDTHH:MM' with no seconds and no
 * zone. Anything unparseable becomes '' — a reading with a broken time is a
 * reading with NO recorded time, which is the honest answer, not now().
 */
export function isoStampOrBlank(v: unknown): string {
  const s = str(v);
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : '';
}

/** A nullable integer: '' and nonsense become null, never 0. */
export function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** 0/1 from anything a form sends, with a stated default. */
export function p6Bool01(v: unknown, dflt: 0 | 1): 0 | 1 {
  if (v === null || v === undefined || String(v).trim() === '') return dflt;
  if (v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true') return 1;
  if (v === false || v === 0 || v === '0' || String(v).toLowerCase() === 'false') return 0;
  return dflt;
}

/**
 * THIS LANE'S THREE UNIQUE INDEXES, IN WORDS.
 *
 * fssai-server.ts's constraintMessage knows the checklist engine's indexes and
 * returns the caller's fallback for anything else — so a duplicate visit number
 * or document code would reach the user as a raw SQLite sentence, or as a 500.
 * This handles the three that are this phase's and then falls back, so the
 * engine's messages are not duplicated here (a copy would drift).
 *
 * ⚠️ MATCH THE COLUMN LIST AS WELL AS THE INDEX NAME. Measured on this project
 * (the comment above constraintMessage says so): SQLite reports a partial unique
 * index violation as "UNIQUE constraint failed: <table>.<col>, <table>.<col>",
 * NOT by index name, so matching only the obvious index name silently falls
 * through to the generic fallback.
 */
export function p6ConstraintMessage(e: any, fallback: string): string | null {
  const code = String(e?.code || '');
  if (!code.startsWith('SQLITE_CONSTRAINT')) return null;
  const m = String(e?.message || '');
  const hit = (index: string, cols: string) => m.includes(index) || m.includes(cols);
  if (hit('uq_fssai_pest_service_no', 'fssai_pest_services.service_no')) {
    return 'Another visit already carries that number. Try saving again — the next number will be allocated.';
  }
  if (hit('uq_fssai_pest_device_code', 'fssai_pest_devices.code')) {
    return 'A monitoring point with that number already exists. Every station needs its own number, because a sighting is filed against it.';
  }
  if (hit('uq_fssai_doc_code', 'fssai_documents.doc_code')) {
    return 'Another document already uses that reference. Try saving again.';
  }
  // An FK failure here means an FK column was written as '' — the one mistake
  // the lane brief names. Say so, rather than printing SQLite at a manager.
  if (m.includes('FOREIGN KEY constraint failed')) {
    return 'That record points at something that no longer exists. Reload the screen and try again.';
  }
  return fallback;
}

/**
 * A JSON array of objects, round-tripped safely into a TEXT column.
 *
 * chemicals_json carries what the contractor actually applied — the one field on
 * a pest visit an inspector reads first — so it must survive a client that sends
 * a string, an object, or nothing, and must never store the text
 * '[object Object]'.
 */
export function jsonArrayText(v: unknown, cap = 60): string {
  let arr: unknown = v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return '[]';
    try { arr = JSON.parse(s); } catch { return '[]'; }
  }
  if (!Array.isArray(arr)) return '[]';
  const clean = arr
    .filter((x) => x && typeof x === 'object' && !Array.isArray(x))
    .slice(0, cap);
  return JSON.stringify(clean);
}

/** The parsed form of the above, for a read. */
export function parseJsonObjects(text: unknown): Record<string, unknown>[] {
  try {
    const v = JSON.parse(String(text || '[]'));
    return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : [];
  } catch {
    return [];
  }
}
