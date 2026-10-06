/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';
import {
  FSSAI_RECORD_TABLES, fssaiVoidRefusal, fssaiRecordStatusMeta,
  type FssaiActor,
} from '@/lib/fssai';
import { fssaiAudit } from '@/lib/fssai-server';

/**
 * P10 — "VOID, NEVER DELETE" (owner §19), in ONE place for every register.
 *
 * ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────────
 * Thirteen tables hold a compliance record (FSSAI_RECORD_TABLES in fssai.ts) and
 * every one of them must be cancellable with a written reason and un-deletable.
 * Eight feature lanes build those registers in parallel. Thirteen hand-written
 * void paths is thirteen chances to drop the reason check, thirteen different
 * refusal sentences for one rule, and — measured on this project — the exact
 * shape of the rival-helper trap (two lanes each wrote a sales-slice.ts with the
 * same export signature and the pair disagreed silently).
 *
 * So the void is written ONCE here and exposed through ONE route
 * (/api/fssai/void). A register screen asks that route; it does not write the
 * void trio itself.
 *
 * ── THE ONE PLACE THIS GOES FURTHER THAN fssai.ts, STATED LOUDLY ─────────────
 * `fssaiVoidRefusal` (fssai.ts §14.1) checks three things: signed in, management,
 * reason of four characters or more, plus "not already void". Its own doc comment,
 * the W1 handover and the owner-facing question Q23 ALL say the rule is also
 * "never the person who wrote the record" —
 *
 *     Q23: "a manager, a head of department or an admin, never the person who
 *           wrote the record, and always with a reason in words."
 *
 * — and the helper does not implement that half. Read it: there is no comparison
 * against recorded_by/checked_by/created_by anywhere in it. A lane that calls it
 * alone therefore ships a WEAKER rule than three documents claim, and the person
 * with a motive to make a bad reading disappear is the one who typed it. That is
 * the inert-guard shape this project has hit four times: a guard that reads
 * correctly and never fires.
 *
 * fssai.ts belongs to W1 and no feature lane may edit it, so the missing half is
 * enforced HERE, where the route can reach it, and reported upward rather than
 * patched into a file two other lanes are reading. `fssaiVoidRefusalForRecord`
 * is `fssaiVoidRefusal` PLUS the author rule, and it is the only refusal the
 * route calls.
 *
 * ── AND THE ONE DELIBERATE EXCEPTION ────────────────────────────────────────
 * An ADMIN may cancel a record he wrote himself. Not laxity — arithmetic: there
 * is no tier above admin in this app (RECON §5 row 13), so refusing him too
 * means a record an admin entered on the wrong fridge can never be cancelled by
 * anybody, for ever. Q23's own example ("a Saturday night reading entered on the
 * wrong fridge") is precisely that case. The allowance is behind a named
 * constant, one line from being turned off, and every such void carries
 * `self_void: true` in its audit row so it can be found in one query.
 */

/* ------------------------------------------------------------------ *
 * The per-table facts a generic void needs
 * ------------------------------------------------------------------ */

export interface FssaiVoidableRecord {
  /** the table, exactly as FSSAI_RECORD_TABLES spells it */
  table: string;
  /** "temperature reading" — one of them, in the words a screen uses */
  one: string;
  /** "Temperature readings" */
  many: string;
  /** the register's page, so a refusal or a trail line can link to it */
  path: string;
  /**
   * The status a cancelled row lands on.
   *
   * 'void' everywhere except corrective actions, whose own vocabulary already
   * settled on 'cancelled' before this file existed (fssaiCaStatus). Two words
   * for one state is not ideal; inventing a THIRD by writing 'void' over a
   * CA would be worse, and the CA route owns that table anyway (see `delegate`).
   */
  voidStatus: string;
  /**
   * Columns holding the EMAIL of the person who filed the row, best first.
   *
   * Only columns that really carry a login. `performed_by` on an equipment event
   * and `handed_over_by` on an oil collection are free text that often names a
   * vendor's technician, so they are NOT author columns — matching a session
   * email against a typed name would be a guess, and a guess in an authority
   * check is a defect.
   */
  authorCols: string[];
  /** columns that identify the row to a person, best first */
  labelCols: string[];
  /** '' when the table has no business_date (documents, corrective actions) */
  dateCol: string;
  /** '' when the table has no department_id (oil collections, pest visits) */
  deptCol: string;
  /** extra assignments the void must make on this table, written out in SQL */
  extraSet: string[];
  /**
   * Another route already owns this table's void, and this one must not become a
   * second writer of the same rows.
   */
  delegate?: { endpoint: string; action: string; why: string };
}

type Extra = Omit<FssaiVoidableRecord, 'table' | 'one' | 'many' | 'path'>;

const BASE: Extra = {
  voidStatus: 'void',
  authorCols: [],
  labelCols: [],
  dateCol: 'business_date',
  deptCol: 'department_id',
  extraSet: [],
};

/**
 * Keyed on the table name so it cannot drift out of step with
 * FSSAI_RECORD_TABLES: the exported list below is built BY MAPPING over that
 * one, and a table added there with no entry here lands in
 * FSSAI_VOIDABLE_MISSING rather than silently becoming un-cancellable.
 */
const EXTRA: Record<string, Partial<Extra>> = {
  fssai_runs: {
    authorCols: ['recorded_by'],
    labelCols: ['business_date', 'shift'],
    delegate: {
      endpoint: '/api/fssai/runs',
      action: 'void',
      why:
        'A checklist round is cancelled on its own route, which also understands the slot rule — '
        + 'a voided round reopens the slot so the check can be taken again.',
    },
  },
  fssai_receiving_checks: {
    authorCols: ['checked_by', 'created_by'],
    labelCols: ['check_no', 'grn_number', 'invoice_number', 'vendor_name'],
  },
  fssai_temperature_logs: {
    authorCols: ['recorded_by'],
    labelCols: ['equipment_label', 'item_label', 'area_label'],
  },
  fssai_equipment_events: {
    // performed_by is free text (often a vendor's technician) — not a login.
    authorCols: ['created_by'],
    labelCols: ['equipment_label', 'event_kind', 'reference_no'],
  },
  fssai_expiry_items: {
    authorCols: ['recorded_by'],
    labelCols: ['batch_label', 'material_name', 'lot_no'],
  },
  fssai_oil_checks: {
    authorCols: ['recorded_by'],
    labelCols: ['equipment_label', 'oil_type'],
  },
  fssai_oil_disposals: {
    // handed_over_by is free text, same reason as performed_by above.
    authorCols: ['created_by'],
    labelCols: ['receipt_no', 'collector_name', 'agency_reg_no'],
    deptCol: '',
  },
  fssai_water_tests: {
    authorCols: ['recorded_by'],
    labelCols: ['source_point', 'test_kind', 'report_no', 'lab_name'],
  },
  fssai_pest_services: {
    authorCols: ['created_by'],
    labelCols: ['service_no', 'vendor_name', 'service_kind'],
    deptCol: '',
  },
  fssai_pest_sightings: {
    authorCols: ['reported_by'],
    labelCols: ['pest_type', 'location_label'],
  },
  fssai_documents: {
    authorCols: ['created_by'],
    labelCols: ['doc_code', 'title', 'reference_no'],
    dateCol: '',
    /* A cancelled licence must stop being treated as a live one. is_active is on
     * this table and on no other voidable one, which is why it is written out
     * here instead of in the shared UPDATE. */
    extraSet: ['is_active = 0'],
  },
  fssai_inspections: {
    authorCols: ['created_by'],
    labelCols: ['inspection_no', 'authority', 'inspector_name'],
  },
  fssai_corrective_actions: {
    authorCols: ['created_by'],
    labelCols: ['ca_number', 'title'],
    dateCol: '',
    voidStatus: 'cancelled',
    delegate: {
      endpoint: '/api/fssai/corrective-actions',
      action: 'cancel',
      why:
        'A corrective action is cancelled on its own route, which guards the status it is coming '
        + 'from — cancelling one that has already been verified is a different decision.',
    },
  },
};

export const FSSAI_VOIDABLE_RECORDS: readonly FssaiVoidableRecord[] = FSSAI_RECORD_TABLES.map((t) => ({
  table: t.table,
  one: t.one,
  many: t.many,
  path: t.path,
  ...BASE,
  ...(EXTRA[t.table] || {}),
}));

/**
 * Tables FSSAI_RECORD_TABLES declares that this file has no facts for — empty
 * today and asserted empty by the P10 probe. If a later wave adds a record table
 * to fssai.ts and forgets this file, the name shows up here and the route says so
 * in words, instead of a register quietly having no way to cancel a row.
 */
export const FSSAI_VOIDABLE_MISSING: readonly string[] =
  FSSAI_RECORD_TABLES.filter((t) => !EXTRA[t.table]).map((t) => t.table);

/** EXTRA keys that no longer exist in FSSAI_RECORD_TABLES — a rename left behind. */
export const FSSAI_VOIDABLE_ORPHANS: readonly string[] =
  Object.keys(EXTRA).filter((k) => !FSSAI_RECORD_TABLES.some((t) => t.table === k));

export function fssaiVoidableRecord(table: string | null | undefined): FssaiVoidableRecord | null {
  const key = String(table || '');
  return FSSAI_VOIDABLE_RECORDS.find((r) => r.table === key) || null;
}

/* ------------------------------------------------------------------ *
 * WHO
 * ------------------------------------------------------------------ */

/**
 * May an admin cancel a record he filed himself?
 *
 * TRUE, and the reasoning is in this file's header: there is no tier above admin,
 * so FALSE means such a record can never be cancelled by anybody. Flip this one
 * line to require a second admin and nothing else changes — the refusal sentence
 * below already says what to do.
 */
export const FSSAI_ADMIN_MAY_VOID_OWN_RECORD = true;

/** The login that filed this row, lower-cased, or '' when the table cannot say. */
export function fssaiRecordAuthorEmail(
  row: Record<string, any> | null | undefined,
  desc: FssaiVoidableRecord,
): string {
  if (!row) return '';
  for (const c of desc.authorCols) {
    const v = String(row[c] ?? '').trim().toLowerCase();
    if (v) return v;
  }
  return '';
}

/**
 * WHY THIS PERSON CANNOT CANCEL THIS RECORD, in words, or '' if they can.
 *
 * = fssaiVoidRefusal (signed in · management · not already void · a reason in
 * words) PLUS the half of Q23 that fssai.ts does not implement: never the person
 * who wrote it. See this file's header for why that lives here.
 */
export function fssaiVoidRefusalForRecord(
  me: (FssaiActor & { email?: string | null }) | null | undefined,
  row: Record<string, any> | null | undefined,
  reason: string | null | undefined,
  desc: FssaiVoidableRecord,
): string {
  const shared = fssaiVoidRefusal(me as any, row as any, reason);
  if (shared) return shared;

  const mine = String(me?.email || '').trim().toLowerCase();
  const author = fssaiRecordAuthorEmail(row, desc);
  if (mine && author && mine === author) {
    if (me?.role === 'admin' && FSSAI_ADMIN_MAY_VOID_OWN_RECORD) return '';
    return `You filed this ${desc.one} yourself, so somebody else has to cancel it — ask an administrator.`;
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * THE VOID
 * ------------------------------------------------------------------ */

export interface FssaiVoidResult {
  ok: true;
  table: string;
  id: string;
  status: string;
  status_label: string;
  voided_at: string;
  voided_by: string;
  void_reason: string;
  /** the actor cancelled their own record (admin override) */
  self_void: boolean;
}

/** A table name may only ever be interpolated into SQL after passing this. */
const SAFE_TABLE = /^fssai_[a-z0-9_]+$/;

/** before_json is frozen history, not a dumping ground — cap it and say so. */
const MAX_BEFORE_JSON = 64 * 1024;

function frozenBefore(row: Record<string, any>, desc: FssaiVoidableRecord): any {
  const full = JSON.stringify(row);
  if (full.length <= MAX_BEFORE_JSON) return row;
  const small: Record<string, any> = { id: row.id, status: row.status };
  for (const c of [...desc.labelCols, desc.dateCol, desc.deptCol].filter(Boolean)) {
    small[c] = row[c];
  }
  small.__truncated = `The full row was ${full.length} characters and was not frozen here.`;
  return small;
}

/**
 * CANCEL ONE RECORD. Never deletes, never edits anything the record says.
 *
 * The caller has already resolved `desc` from the allowlist and run
 * fssaiVoidRefusalForRecord. This function does the write and nothing else, in
 * ONE transaction with its audit row — and `fssaiAudit` THROWS rather than
 * swallowing, deliberately, which is the opposite of the §7 Q4 rule for a check
 * a member of staff performed. Q4 protects information from being lost. This
 * path REMOVES a record from the live register, so a cancellation that cannot be
 * recorded must not happen at all: the transaction rolls back and the caller
 * gets a 500. A silent void is the one outcome §19 exists to prevent.
 *
 * better-sqlite3 is synchronous — nothing is awaited inside the transaction.
 */
export function voidFssaiRecord(
  db: Database.Database,
  args: {
    desc: FssaiVoidableRecord;
    row: Record<string, any>;
    reason: string;
    actor: { email?: string | null; name?: string | null; role?: string | null };
    outletId?: string | null;
  },
): FssaiVoidResult | { conflict: string } {
  const { desc, row, reason, actor } = args;
  if (!SAFE_TABLE.test(desc.table)) {
    // Unreachable through the route (desc comes from the allowlist); here so a
    // future descriptor typo cannot reach SQL.
    throw new Error(`Refusing to build SQL for the table name "${desc.table}".`);
  }

  const sets = [
    `status = ?`,
    `voided_at = datetime('now')`,
    `voided_by = ?`,
    `void_reason = ?`,
    `updated_at = datetime('now')`,
    ...desc.extraSet,
  ].join(', ');

  /* The WHERE is the race guard: two managers pressing Cancel at the same moment
   * both pass the refusal check, and the second UPDATE changes 0 rows rather
   * than overwriting the first one's reason. */
  const upd = db.prepare(
    `UPDATE ${desc.table} SET ${sets}
      WHERE id = ? AND status <> ? AND COALESCE(voided_at, '') = ''`,
  );

  const author = fssaiRecordAuthorEmail(row, desc);
  const mine = String(actor.email || '').trim().toLowerCase();
  const selfVoid = !!(mine && author && mine === author);

  let conflict = '';
  const run = db.transaction(() => {
    const res = upd.run(desc.voidStatus, actor.email || '', reason, row.id, desc.voidStatus);
    if (res.changes !== 1) {
      conflict = `That ${desc.one} has already been cancelled.`;
      return;
    }
    fssaiAudit(db, {
      entity_table: desc.table,
      entity_id: String(row.id),
      action: 'void',
      field: 'status',
      before: frozenBefore(row, desc),
      after: {
        status: desc.voidStatus,
        voided_by: actor.email || '',
        void_reason: reason,
        /* Findable in one query: SELECT … WHERE action='void' AND after_json LIKE
         * '%"self_void":true%'. An admin cancelling his own record is lawful and
         * is exactly the line an inspector would want pointed out. */
        self_void: selfVoid,
      },
      reason,
      actor: { email: actor.email, name: actor.name },
      outlet_id: args.outletId ?? row.outlet_id ?? '',
    });
  });
  run();

  if (conflict) return { conflict };

  const after = db.prepare(
    `SELECT status, voided_at, voided_by, void_reason FROM ${desc.table} WHERE id = ?`,
  ).get(row.id) as any;

  return {
    ok: true,
    table: desc.table,
    id: String(row.id),
    status: String(after?.status || desc.voidStatus),
    status_label: fssaiRecordStatusMeta(String(after?.status || desc.voidStatus)).label,
    voided_at: String(after?.voided_at || ''),
    voided_by: String(after?.voided_by || ''),
    void_reason: String(after?.void_reason || reason),
    self_void: selfVoid,
  };
}

/* ------------------------------------------------------------------ *
 * Reading one record back, for the confirmation a screen shows
 * ------------------------------------------------------------------ */

/** The row as a person reads it: what it is, who filed it, and its state. */
export function describeFssaiRecord(row: Record<string, any>, desc: FssaiVoidableRecord) {
  const bits = desc.labelCols.map((c) => String(row[c] ?? '').trim()).filter(Boolean);
  const status = String(row.status || '');
  return {
    table: desc.table,
    one: desc.one,
    many: desc.many,
    path: desc.path,
    id: String(row.id || ''),
    /* Never invent a label. A row whose identifying columns are all blank reads
     * as its own kind, which is true, rather than as an empty string. */
    label: bits.length ? bits.join(' · ') : desc.one,
    status,
    status_label: fssaiRecordStatusMeta(status).label,
    author_email: fssaiRecordAuthorEmail(row, desc),
    business_date: desc.dateCol ? String(row[desc.dateCol] ?? '') : '',
    department_id: desc.deptCol ? String(row[desc.deptCol] ?? '') : '',
    voided_at: String(row.voided_at || ''),
    voided_by: String(row.voided_by || ''),
    void_reason: String(row.void_reason || ''),
    outlet_id: String(row.outlet_id || ''),
  };
}

/**
 * Does this table exist in the database yet?
 *
 * Needed because the registers land wave by wave: a screen or the audit trail may
 * name `fssai_water_tests` on a database whose last cold start predates it, and
 * `initializeSchema` swallows schema errors per block (HARD RULE 7), so "the
 * table is missing" is a real state this module has to answer for rather than a
 * 500 with a SQLite message in it.
 */
export function fssaiTableExists(db: Database.Database, table: string): boolean {
  if (!SAFE_TABLE.test(table)) return false;
  const r = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
  ).get(table) as any;
  return !!r;
}
