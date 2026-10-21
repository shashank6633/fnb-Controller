/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * THE BITS ALL THREE P5 ROUTES SHARE — FIFO/expiry, oil, water.
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT IS HERE AND NOT IN src/lib ─────────────
 * Three routes in this phase ask the identical questions: is this reading
 * outside the limit the owner set, who may void this row, where does the
 * photograph go, and does a judged failure raise a corrective action. Writing
 * those four answers three times is three chances for them to disagree, which
 * is exactly the trap this project already paid for once (two lanes each wrote
 * a sales-slice.ts with the same export signature and they silently disagreed).
 *
 * It sits in a private folder under this phase's own api tree — the house
 * pattern already used by src/app/api/direct-items/_lib and
 * src/app/api/inventory/central-cutover/_lib — rather than in src/lib, because
 * seven sibling lanes are editing this worktree right now and src/lib/fssai.ts,
 * db.ts, page-catalog.ts and Sidebar.tsx are not this lane's to touch. A folder
 * whose name says which phase owns it cannot be created twice by accident. An
 * underscore folder is never routed by the App Router, so nothing here is
 * reachable over HTTP.
 *
 * NOTHING IN HERE IS A SECOND CONVENTION. Every vocabulary, every predicate
 * about who may do what, and every range test comes from src/lib/fssai.ts; the
 * gates, the CSRF re-check and the audit writer come from src/lib/fssai-server.ts.
 * This file only joins them up.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
import { isManagement, type SessionUser } from '@/lib/auth';
import {
  fssaiToday, isISODate, fssaiCaDueDate, isFssaiCaSeverity,
  isFssaiAttachmentEntity, parseFssaiDataUri, FSSAI_PHOTO_MIMES,
} from '@/lib/fssai';
import {
  FSSAI_NO_MATCH, fssaiAuditBestEffort, nextFssaiCaNumber, str,
} from '@/lib/fssai-server';

/** Every P5 list is capped, and every P5 response says whether it was. */
export const P5_LIST_LIMIT = 300;

/**
 * How many photographs may hang off ONE P5 record.
 *
 * The same four the checklist runner allows per answer (FSSAI_PHOTO_* in
 * src/lib/fssai.ts), for the same reason: these are stored in-row as TEXT data
 * URIs, so the count IS the storage budget. A used-oil receipt and a lab
 * certificate are one page each; four is generous and still bounded.
 */
export const P5_MAX_ATTACHMENTS = 4;

/* ------------------------------------------------------------------ *
 * Reading numbers off a request body without inventing zeros
 * ------------------------------------------------------------------ */

/**
 * A nullable REAL out of a request body. NULL MEANS NOT RECORDED.
 *
 * This is the single most important function in the file. Every measured column
 * in P5 — tpm_pct, value_num, qty, temp_c — is `REAL` with no DEFAULT precisely
 * so that "nobody measured it" and "it measured zero" stay different facts. A
 * `Number(body.x) || 0` anywhere in this phase would turn an un-taken reading
 * into a reading of 0, and 0 ppm of chlorine or 0% TPM both read as a result.
 * So: '' / null / undefined / NaN all become null, and only a finite number
 * becomes a number.
 */
export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The same rule for an INTEGER column that is nullable (days, minutes). */
export function nullableInt(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

/**
 * A business date off the body, or the refusal in words.
 *
 * A record is an observation of something that HAS happened, so a date in the
 * future is refused rather than silently corrected — a reading filed for
 * tomorrow would sit in the file as a check nobody could have taken. Backdating
 * is allowed (the storekeeper writes up yesterday's collection this morning) and
 * is not silently accepted either: the caller gets `backdated` so the response
 * and the audit row can say so.
 */
export function readBusinessDate(
  v: unknown,
  today: string = fssaiToday(),
): { ok: true; date: string; backdated: boolean } | { ok: false; error: string } {
  const d = str(v) || today;
  if (!isISODate(d)) {
    return { ok: false, error: `"${str(v)}" is not a date. Use the date picker.` };
  }
  if (d > today) {
    return {
      ok: false,
      error: `That date (${d}) is in the future. A food-safety record says what was found, so it cannot be filed before it happens.`,
    };
  }
  return { ok: true, date: d, backdated: d < today };
}

/** 'HH:MM' off the body, or '' — never a half-parsed time. */
export function readClock(v: unknown): string {
  const s = str(v);
  if (!s) return '';
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return '';
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Who may see which rows
 * ------------------------------------------------------------------ */

/**
 * WHICH RECORDS MAY THIS PERSON SEE — the same shape the runs list and the
 * corrective-action list already use, so one person does not see three
 * different answers to "is this mine" across the module.
 *
 * Management sees everything. Everybody else sees a record in their own
 * department, or one they recorded themselves. A record with NO department is
 * restaurant-wide and visible to any signed-in user — the precedent is P2's
 * fix, where a restaurant-wide record refused a colleague with "belongs to
 * another department".
 *
 * FSSAI_NO_MATCH and never '': a user with no department must see the records
 * that are HIS, not every record whose department column happens to be blank.
 */
export function p5VisibilityClause(
  me: SessionUser,
  alias: string,
  recordedColumn = 'recorded_by',
): { sql: string; args: any[] } {
  if (isManagement(me)) return { sql: '', args: [] };
  return {
    sql: `(${alias}.department_id = ''
           OR ${alias}.department_id = ?
           OR lower(IFNULL(${alias}.${recordedColumn},'')) = lower(?))`,
    args: [me.department_id || FSSAI_NO_MATCH, me.email || FSSAI_NO_MATCH],
  };
}

/** The row-level mirror of p5VisibilityClause, for a single-record read. */
export function p5CanSee(me: SessionUser, row: any, recordedColumn = 'recorded_by'): boolean {
  if (isManagement(me)) return true;
  const mine = String(me.email || '').trim().toLowerCase();
  if (mine && String(row?.[recordedColumn] || '').trim().toLowerCase() === mine) return true;
  const dept = String(row?.department_id || '');
  return !dept || dept === me.department_id;
}

/* ------------------------------------------------------------------ *
 * The limit a reading is judged against
 * ------------------------------------------------------------------ */

export interface P5Standard {
  id: string;
  code: string;
  label: string;
  min_value: number | null;
  max_value: number | null;
  target_value: number | null;
  uom: string;
  decimals: number;
  authority: string;
}

/**
 * THE MOST SPECIFIC ACTIVE STANDARD FOR THIS READING, or null.
 *
 * §5 of the owner's brief: the limits are configurable and never hard-coded. So
 * an oil check does not compare against FSSAI_OIL_TPM_LIMIT_PCT and a chlorine
 * reading does not compare against a literal — both come through here, out of
 * fssai_temp_standards, and the limit that was ACTUALLY applied is then frozen
 * onto the record (max_tpm_used / min_used / max_used) so tightening the
 * standard next month cannot retrospectively fail a fryer that passed.
 *
 * Specificity order, most specific first: the item AND the kind of equipment,
 * then the item, then the kind, then the catch-all. '' on either column means
 * "any", which is how one row covers every fryer.
 *
 * `preferCode` exists for the water tests and nothing else. fssai_temp_standards
 * has ONE applies_to column, so 'water' cannot by itself tell a chlorine limit
 * (0.2–1.0 ppm) from a pH limit (6.5–8.5) — two completely different rules about
 * the same tap. The stable `code` is the only column that can, so a water test
 * asks for its own code first ('WATER-CHLORINE', 'WATER-PH', …) and falls back to
 * a generic water standard. ⚠️ That naming is a CONVENTION THIS PHASE IS
 * PROPOSING, not one the schema enforces: fssai_temp_standards is P4's table and
 * its seed is P8's, so the convention is written down in the phase report rather
 * than assumed to exist. Nothing breaks if no such row is ever created — the
 * reading is simply recorded unjudged, or judged against a limit the person
 * doing the test typed in.
 *
 * ⚠️ RETURNS NULL TODAY, AND THAT IS THE HONEST ANSWER. fssai_temp_standards
 * holds no rows until the owner sets his limits (or P8's seed pack runs), so
 * every caller must handle null by recording the reading UNJUDGED (is_judged=0)
 * and saying so on the screen. A route that invented a limit here would be the
 * hard-coding §5 forbids; a route that treated "no limit" as a pass would paint
 * an unchecked kitchen green.
 */
export function readP5Standard(
  db: Database.Database,
  p: {
    appliesTo: string;
    equipmentKind?: string;
    materialId?: string;
    outletId?: string;
    preferCode?: string;
  },
): P5Standard | null {
  const kind = str(p.equipmentKind);
  const material = str(p.materialId);

  const preferCode = str(p.preferCode);
  if (preferCode) {
    const exact = db.prepare(
      `SELECT id, code, label, min_value, max_value, target_value, uom, decimals, authority
         FROM fssai_temp_standards
        WHERE is_active = 1 AND code = ? AND (outlet_id = '' OR outlet_id = ?)
        ORDER BY sort_order ASC, created_at ASC, rowid ASC
        LIMIT 1`,
    ).get(preferCode, str(p.outletId)) as any;
    if (exact) return shapeStandard(exact);
  }

  const row = db.prepare(
    `SELECT id, code, label, min_value, max_value, target_value, uom, decimals, authority
       FROM fssai_temp_standards
      WHERE is_active = 1
        AND applies_to = ?
        AND (material_id = '' OR material_id = ?)
        AND (equipment_kind = '' OR equipment_kind = ?)
        AND (outlet_id = '' OR outlet_id = ?)
      ORDER BY
        CASE WHEN material_id <> '' THEN 0 ELSE 1 END ASC,
        CASE WHEN equipment_kind <> '' THEN 0 ELSE 1 END ASC,
        sort_order ASC, created_at ASC, rowid ASC
      LIMIT 1`,
  ).get(p.appliesTo, material, kind, str(p.outletId)) as any;
  return row ? shapeStandard(row) : null;
}

/** One standard row, shaped once. NULL bounds stay NULL — never 0. */
function shapeStandard(row: any): P5Standard {
  return {
    id: String(row.id),
    code: String(row.code || ''),
    label: String(row.label || ''),
    min_value: row.min_value === null || row.min_value === undefined ? null : Number(row.min_value),
    max_value: row.max_value === null || row.max_value === undefined ? null : Number(row.max_value),
    target_value: row.target_value === null || row.target_value === undefined ? null : Number(row.target_value),
    uom: String(row.uom || ''),
    decimals: Number(row.decimals) || 0,
    authority: String(row.authority || ''),
  };
}

/* ------------------------------------------------------------------ *
 * Photographs and scans
 * ------------------------------------------------------------------ */

export interface P5AttachmentInput {
  data_uri?: unknown;
  filename?: unknown;
  caption?: unknown;
  kind?: unknown;
}

export interface P5AttachmentResult {
  id: string;
  kind: string;
  filename: string;
  mime: string;
  size_bytes: number;
  caption: string;
}

/**
 * Attach photographs or a scan to a P5 record — into fssai_attachments, NEVER
 * into fssai_evidence.
 *
 * WHY NOT fssai_evidence, which already stores photographs: its run_id is NOT
 * NULL with a foreign key to fssai_runs, and computeFssaiSheetDigest hashes
 * that whole table into the signature over a checklist round. A used-oil
 * receipt with no run would either not insert at all or land inside somebody
 * else's attestation. fssai_attachments is the store the record tables were
 * given, with the same photograph budget and the same 12-month retention.
 *
 * entity_table is validated against FSSAI_ATTACHMENT_ENTITIES BEFORE the insert,
 * so a caller-supplied table name can never reach SQL and an attachment can
 * never point at a table that does not exist.
 *
 * THROWS on a bad photograph, deliberately: the caller is inside the write
 * transaction for the record itself, and a person who attached a certificate
 * must not be told the record saved while the certificate silently vanished.
 */
export function attachP5Files(
  db: Database.Database,
  p: {
    entityTable: string;
    entityId: string;
    files: P5AttachmentInput[];
    actor: { email?: string | null; name?: string | null };
    outletId: string;
  },
): P5AttachmentResult[] {
  const out: P5AttachmentResult[] = [];
  if (!p.files.length) return out;

  if (!isFssaiAttachmentEntity(p.entityTable)) {
    // Not a user's mistake — a programming one. Named so it is obvious in a log.
    throw new Error(`P5_BAD_ATTACHMENT_ENTITY:${p.entityTable}`);
  }
  if (p.files.length > P5_MAX_ATTACHMENTS) {
    throw new Error(
      `P5_TOO_MANY_PHOTOS:You can attach up to ${P5_MAX_ATTACHMENTS} pictures to one record; this sent ${p.files.length}.`,
    );
  }

  for (const f of p.files) {
    const parsed = parseFssaiDataUri(f?.data_uri as string);
    if (!parsed.ok) throw new Error(`P5_BAD_PHOTO:${parsed.error}`);
    const kind = str(f?.kind) || 'photo';
    const filename = str(f?.filename).slice(0, 200);
    const caption = str(f?.caption).slice(0, 500);
    const id = generateId();
    // Over the DECODED bytes, so the digest survives the image being dropped by
    // the retention sweep and still identifies what was attached.
    const digest = createHash('sha256').update(Buffer.from(parsed.b64, 'base64')).digest('hex');
    db.prepare(
      `INSERT INTO fssai_attachments
         (id, entity_table, entity_id, kind, data_uri, filename, mime, size_bytes,
          caption, digest_sha256, created_by, outlet_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, p.entityTable, p.entityId, kind, String(f?.data_uri || ''),
      filename, parsed.mime, parsed.bytes, caption, digest,
      p.actor.email || '', p.outletId,
    );
    out.push({ id, kind, filename, mime: parsed.mime, size_bytes: parsed.bytes, caption });
  }
  return out;
}

/** What a screen shows for one record's attachments — the row, never the image. */
export function readP5AttachmentIndex(
  db: Database.Database,
  entityTable: string,
  entityIds: string[],
): Map<string, { id: string; kind: string; filename: string; mime: string; size_bytes: number; caption: string; image_dropped_at: string }[]> {
  const index = new Map<string, any[]>();
  if (!entityIds.length) return index;
  const placeholders = entityIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, entity_id, kind, filename, mime, size_bytes, caption, image_dropped_at
       FROM fssai_attachments
      WHERE entity_table = ? AND entity_id IN (${placeholders})
      ORDER BY created_at ASC, rowid ASC`,
  ).all(entityTable, ...entityIds) as any[];
  for (const r of rows) {
    const key = String(r.entity_id);
    if (!index.has(key)) index.set(key, []);
    index.get(key)!.push({
      id: String(r.id),
      kind: String(r.kind || 'photo'),
      filename: String(r.filename || ''),
      mime: String(r.mime || ''),
      size_bytes: Number(r.size_bytes) || 0,
      caption: String(r.caption || ''),
      image_dropped_at: String(r.image_dropped_at || ''),
    });
  }
  return index;
}

/** The stored data URI for one attachment, checked against its record. */
export function readP5AttachmentImage(
  db: Database.Database,
  entityTable: string,
  attachmentId: string,
): { entity_id: string; mime: string; data_uri: string; filename: string; image_dropped_at: string } | null {
  const row = db.prepare(
    `SELECT entity_id, mime, data_uri, filename, image_dropped_at
       FROM fssai_attachments WHERE id = ? AND entity_table = ?`,
  ).get(attachmentId, entityTable) as any;
  if (!row) return null;
  const mime = String(row.mime || '');
  return {
    entity_id: String(row.entity_id),
    // Belt and braces on the way OUT as well as in: the column is handed to a
    // browser as an <img src>, and a row written before this check existed must
    // not be the one that gets through.
    mime: FSSAI_PHOTO_MIMES.includes(mime) ? mime : '',
    data_uri: String(row.data_uri || ''),
    filename: String(row.filename || ''),
    image_dropped_at: String(row.image_dropped_at || ''),
  };
}

/* ------------------------------------------------------------------ *
 * A judged failure raises the action that fixes it
 * ------------------------------------------------------------------ */

export interface P5CaRaised {
  id: string;
  ca_number: string;
  title: string;
  severity: string;
  due_date: string;
}

/**
 * RAISE ONE CORRECTIVE ACTION FOR A P5 RECORD THAT FAILED ITS LIMIT.
 *
 * ── WHY THIS IS HERE AND NOT A COPY OF THE RUN RAISER ───────────────────────
 * raiseFssaiCorrectiveActions (src/lib/fssai-server.ts) raises actions for
 * failed ANSWERS on a checklist round: it reads fssai_responses and writes
 * run_id. An oil check is not a round and has no response row, so it cannot go
 * through that path. It uses the SAME number allocator (nextFssaiCaNumber), the
 * SAME due-date rule (fssaiCaDueDate) and the SAME audit writer, so a P5 action
 * is indistinguishable from a checklist one in the queue and in the file.
 *
 * ── THE TWO THINGS THAT WILL BITE A READER ──────────────────────────────────
 *   · run_id IS WRITTEN NULL, never ''. PRAGMA foreign_keys is ON (db.ts:108)
 *     and fssai_corrective_actions.run_id has a foreign key to fssai_runs, so
 *     '' is a reference to a run that does not exist and the insert throws.
 *   · source_kind carries 'oil' / 'water' / 'expiry'. The column is TEXT with no
 *     CHECK and nothing in the app reads it today, so new values are additive —
 *     but see the known gap reported with this phase: the corrective-action
 *     screen prints "Raised by hand" for any action with no run, which is wrong
 *     for these. The title and description below are therefore written to stand
 *     completely on their own, naming the record, the reading and the limit, so
 *     somebody who picks the job up days later needs nothing else.
 *
 * ── BEST-EFFORT, AND THE TRADE IS DELIBERATE ────────────────────────────────
 * Called inside the caller's transaction (nextFssaiCaNumber needs that), and
 * every failure is caught here so it cannot roll the record back. The reasoning
 * is the one the run raiser already settled: never lose a check a member of
 * staff really performed because a follow-up row would not insert. If this
 * returns null the FAILURE IS STILL ON THE RECORD in red, and the caller says
 * so in its response rather than pretending an action exists.
 */
export function raiseP5CorrectiveAction(
  db: Database.Database,
  p: {
    sourceKind: string;
    title: string;
    description: string;
    severity: string;
    departmentId?: string;
    equipmentId?: string;
    businessDate: string;
    recordTable: string;
    recordId: string;
    actor: { email?: string | null; name?: string | null };
    outletId: string;
  },
): P5CaRaised | null {
  try {
    const severity = isFssaiCaSeverity(p.severity) ? p.severity : 'medium';
    const businessDate = isISODate(p.businessDate) ? p.businessDate : fssaiToday();
    const id = generateId();
    const caNumber = nextFssaiCaNumber(db, businessDate);
    const dueDate = fssaiCaDueDate(severity, businessDate);
    const title = p.title.slice(0, 300);

    db.prepare(
      `INSERT INTO fssai_corrective_actions
         (id, ca_number, source_kind, run_id, response_id, equipment_id, department_id,
          title, description, severity, status, owner_email, due_date, created_by, outlet_id)
       VALUES (?, ?, ?, NULL, '', ?, ?, ?, ?, ?, 'open', '', ?, ?, ?)`,
    ).run(
      id, caNumber, p.sourceKind,
      str(p.equipmentId), str(p.departmentId),
      title, p.description, severity,
      dueDate, p.actor.email || '', p.outletId,
    );

    fssaiAuditBestEffort(db, {
      entity_table: 'fssai_corrective_actions',
      entity_id: id,
      action: 'create',
      after: {
        ca_number: caNumber, source_kind: p.sourceKind, severity, status: 'open',
        title, record_table: p.recordTable, record_id: p.recordId,
      },
      reason: `Raised automatically: this ${p.sourceKind} record was outside the limit that was set for it.`,
      actor: p.actor,
      outlet_id: p.outletId,
    });

    return { id, ca_number: caNumber, title, severity, due_date: dueDate };
  } catch (e) {
    // See the contract above: the record is already true without this.
    console.error(`raiseP5CorrectiveAction failed (the ${p.recordTable} record stands):`, e);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Void, never delete (owner §19)
 * ------------------------------------------------------------------ */

/**
 * The UPDATE that voids one P5 record, status-guarded.
 *
 * The REFUSAL is not computed here — it is fssaiVoidRefusal in
 * src/lib/fssai.ts, shared with P4 and P6, so "management only, never the
 * recorder, reason of at least four characters" is written once. The caller
 * checks it, shows it in the server's own words, and then calls this.
 *
 * `table` must come from the caller as a literal, never from a request body:
 * it is interpolated into SQL. Every call site in this phase passes one of its
 * own three table names.
 *
 * Returns the number of rows changed — 0 means somebody voided it first, which
 * the caller reports as a 409 rather than claiming success.
 */
export function voidP5Record(
  db: Database.Database,
  table: 'fssai_expiry_items' | 'fssai_oil_checks' | 'fssai_oil_disposals' | 'fssai_water_tests',
  p: { id: string; reason: string; actor: { email?: string | null; name?: string | null } },
): number {
  const res = db.prepare(
    `UPDATE ${table}
        SET status = 'void', voided_at = datetime('now'), voided_by = ?,
            void_reason = ?, updated_at = datetime('now')
      WHERE id = ? AND status <> 'void'`,
  ).run(p.actor.email || '', p.reason, p.id);
  return res.changes;
}

/* ------------------------------------------------------------------ *
 * Small shared shaping
 * ------------------------------------------------------------------ */

/** A REAL column as the screen needs it: a number, or null for NOT RECORDED. */
export function real(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The void trio every P5 record carries, shaped once. */
export function voidFields(row: any) {
  return {
    voided_at: String(row.voided_at || ''),
    voided_by: String(row.voided_by || ''),
    void_reason: String(row.void_reason || ''),
  };
}

/**
 * The words a screen shows about a reading that was not judged.
 *
 * Said in one place because all three P5 screens will show it until the owner
 * sets his limits, and three different sentences about the same gap would read
 * as three different gaps.
 */
export function p5UnjudgedNotice(what: string, settingsHint = 'Settings'): string {
  return `No limit has been set for ${what} yet, so readings are kept but nothing is judged pass or fail. Set one in ${settingsHint} and every reading taken from then on is judged against it.`;
}
