/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';
import {
  addDaysISO, daysBetweenISO, fssaiDocState, fssaiDocType, fssaiTempLogKindLabel, isISODate,
  FSSAI_DOC_REMINDER_DAYS,
} from '@/lib/fssai';
import { fssaiTablesPresent, intOr, numOrBlank } from '../_p9/lib';
import { supplierLicencesByVendor, vendorRegisterReady } from '../../vendors/fssai-register';

/**
 * THE ONE AUDIT FILE (/fssai/audit-file) — the Hyderabad Food Safety Authority's
 * section "Records You Should Keep Ready in One Audit File", all 20 lines, in
 * the authority's order and in the authority's words.
 *
 * ── ONE FUNCTION, TWO OUTPUTS ───────────────────────────────────────────────
 * buildAuditFile() is the ONLY place a status is worked out. The page reads it
 * as JSON (./route.ts) and the PDF draws it (./pdf/route.ts → ./pdf-render.ts).
 * A record that says PRESENT on the screen therefore cannot say anything else
 * on paper — there is no second calculation for them to disagree with.
 *
 * ── WHAT THE THREE STATUSES MEAN ────────────────────────────────────────────
 * The question each status answers is "would this record satisfy the inspector
 * if they asked for it TODAY?"
 *   PRESENT  — yes.
 *   EXPIRING — yes today, but it lapses soon: a document inside its own renewal
 *              window, or a log whose last entry is older than its cadence.
 *              Act before the inspector does.
 *   MISSING  — no: nothing on file, it has lapsed (expired, overdue, gone
 *              quiet), or what is on file is not what the authority asks for
 *              (a licence NUMBER with no COPY of the licence attached).
 * Every non-PRESENT record carries `problems` (why, in words a manager can act
 * on) and `todo` (what closes it). Nothing here is judged on a hidden rule: the
 * cadence and window behind every log are in CADENCE below and printed in
 * `basis`, so the page can say how it decided.
 *
 * ── A COPY IS THE RECORD, NOT THE NUMBER ────────────────────────────────────
 * The authority asks for a "licence copy", "certificates" and "reports". A
 * fssai_documents row with a licence number and no scan attached is the app
 * knowing the number — the inspector cannot read it off a screen row. So a
 * document counts only when an image of it is still STORED
 * (fssai_attachments.data_uri <> ''). The 12-month photo sweep can empty that
 * column on a document still in force (fssai-retention.ts); when it has, the
 * record turns MISSING here and says the scan was removed and when — which is
 * exactly the moment somebody needs to re-attach it.
 *
 * ── READ-ONLY ───────────────────────────────────────────────────────────────
 * There is no INSERT, UPDATE or DELETE in this file. Voided records (§19: void,
 * never delete) are excluded from what counts, and drafts are not filed
 * records, so neither can make a record PRESENT.
 *
 * ── TABLES THAT ARE NOT THERE ───────────────────────────────────────────────
 * initializeSchema swallows errors per block, so a register can be absent on a
 * real server without anything having said so. Each record asks
 * fssaiTablesPresent() first; an absent register makes that record MISSING with
 * the reason, never PRESENT on an empty read and never a 500 for the page.
 *
 * ── OUTLETS ─────────────────────────────────────────────────────────────────
 * Like Inspection Mode, the Reports screen and the dashboard, this reads every
 * outlet's records together. FSSAI records are kept per premises in practice;
 * the app does not split them yet.
 */

/* ══════════════════════════════════════════════════════════════════════════
 * THE AUTHORITY'S LIST — exact wording, exact order
 * ══════════════════════════════════════════════════════════════════════════ */

/** The section heading, as the authority prints it. */
export const AUDIT_FILE_SECTION = 'Records You Should Keep Ready in One Audit File';

/**
 * The 20 lines, character for character as they appear in
 * docs/fssai/hyderabad-audit-checklist.json (from the owner's Excel, master
 * sheet). `n` is the authority's line number within the section. The proof
 * script compares these strings to that file; change one and it fails.
 */
export const AUDIT_FILE_RECORDS = [
  { n: 1, key: 'fssai_licence', title: 'FSSAI licence copy' },
  { n: 2, key: 'fsdb_photo', title: 'FSDB photograph' },
  { n: 3, key: 'ghmc_licence', title: 'GHMC licence' },
  { n: 4, key: 'water', title: 'Water test report / water bill' },
  { n: 5, key: 'pest_control', title: 'Pest-control agreement + reports' },
  { n: 6, key: 'medical', title: 'Food-handler medical certificates' },
  { n: 7, key: 'training', title: 'Food-safety training records' },
  { n: 8, key: 'vendors', title: 'Approved vendor list' },
  { n: 9, key: 'receiving', title: 'Receiving checklist' },
  { n: 10, key: 'cold_temps', title: 'Refrigerator/freezer temperature log' },
  { n: 11, key: 'cooking_temps', title: 'Cooking/reheating temperature log' },
  { n: 12, key: 'cleaning', title: 'Cleaning & sanitation checklist' },
  { n: 13, key: 'pest_monitoring', title: 'Pest-control monitoring sheet' },
  { n: 14, key: 'waste', title: 'Waste disposal record' },
  { n: 15, key: 'oil', title: 'Used cooking-oil/TPC records' },
  { n: 16, key: 'maintenance', title: 'Equipment maintenance records' },
  { n: 17, key: 'calibration', title: 'Calibration certificates' },
  { n: 18, key: 'fifo', title: 'FIFO/FEFO checklist' },
  { n: 19, key: 'food_lab', title: 'Food sampling/lab reports, where applicable' },
  { n: 20, key: 'previous_audit', title: 'Previous audit report and closure evidence' },
] as const;

export type AuditFileKey = (typeof AUDIT_FILE_RECORDS)[number]['key'];

/* ══════════════════════════════════════════════════════════════════════════
 * THE RULES — every threshold in one place, and printed on the page
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * How recent a running log's last entry must be.
 *   fresh — the last entry is at most this many days old → PRESENT.
 *   stale — older than fresh but at most this → EXPIRING (the log is lapsing).
 *           Older than this, or nothing at all → MISSING.
 * Age 0 = today, 1 = yesterday (business dates, IST).
 */
export const CADENCE = {
  receiving: { fresh: 3, stale: 14, words: 'at every delivery' },
  cold_temps: { fresh: 1, stale: 7, words: 'every day' },
  cooking_temps: { fresh: 1, stale: 7, words: 'every day' },
  cleaning: { fresh: 1, stale: 7, words: 'every day' },
  pest_monitoring: { fresh: 1, stale: 7, words: 'every day' },
  oil: { fresh: 2, stale: 7, words: 'every frying day' },
  fifo: { fresh: 2, stale: 8, words: 'daily, with a weekly rotation round' },
} as const;

/** How long a record that carries no expiry date of its own stays current. */
export const CURRENCY_DAYS = {
  /** A water potability test: six-monthly, unless the report gives its own next date. */
  water_test: 182,
  /** A municipal water bill stands for the quarter it was issued in. */
  water_bill: 92,
  /** A waste collector's receipt or record with no end date of its own. */
  waste_record: 92,
  /** A pest-control visit report, when the technician did not write the next date. */
  pest_visit: 31,
  /** A food lab report with no validity date of its own: yearly. */
  food_lab: 365,
  /** Maintenance: some service or repair recorded within this many days. */
  maintenance: 92,
} as const;

/** Days before the end of a dated record's currency that it turns EXPIRING. */
export const WARN_DAYS = 30;
/** Pest visits are monthly, so a 30-day warning would be permanent. */
const PEST_WARN_DAYS = 7;
/** Periodic registers (pest visits, maintenance) list at least this many days. */
const PERIODIC_DAYS = 92;

export const AUDIT_FILE_DAY_CHOICES = [7, 30, 90] as const;
export const AUDIT_FILE_DEFAULT_DAYS = 30;

/* ══════════════════════════════════════════════════════════════════════════
 * SHAPES
 * ══════════════════════════════════════════════════════════════════════════ */

export type AuditFileStatus = 'present' | 'expiring' | 'missing';

export interface AuditFileLink { href: string; label: string }

export interface AuditFileColumn { label: string; width: number; align?: 'left' | 'right' }

export interface AuditFileRow {
  cells: string[];
  /** Where this one record lives in the app ('' = no per-record page). */
  href: string;
  /** 'bad' = a failed/expired line, 'warn' = expiring. Colours only. */
  tone: '' | 'bad' | 'warn';
  /**
   * false = this line only describes a gap (a document row with no copy
   * attached), so the handover PDF leaves it out (§7 Q11). The page and the
   * management copy show every line.
   */
  in_handover: boolean;
}

export interface AuditFileTable {
  title: string;
  columns: AuditFileColumn[];
  rows: AuditFileRow[];
  /** Rows that exist beyond `rows` (cut by the row limit). */
  more: number;
  /** Of ALL the rows (before the limit), how many the handover may carry. */
  handover_rows: number;
  /** Shown when there are no rows — neutral words about the period. */
  empty: string;
}

export interface AuditFileScan {
  attachment_id: string;
  entity_table: string;
  entity_id: string;
  /** Which record this is a copy of, in words. */
  record_label: string;
  filename: string;
  mime: string;
  size_bytes: number;
  caption: string;
  created_at: string;
  /** false once the retention sweep (or a manager) removed the image. */
  has_image: boolean;
  image_dropped_at: string;
}

export interface AuditFileItem {
  n: number;
  key: AuditFileKey;
  /** The authority's line, verbatim. */
  title: string;
  status: AuditFileStatus;
  /**
   * Something is on file to show: a line the handover may carry, or a stored
   * copy. Worked out once, in buildAuditFile, from the tables and scans — the
   * handover PDF leaves out every record where it is false.
   */
  held: boolean;
  /** What is on file now, in one line. */
  headline: string;
  /** Why it is not PRESENT. Empty when it is. */
  problems: string[];
  /** What closes it. '' when PRESENT. */
  todo: string;
  /** The earliest date something on this record lapses ('' = none known). */
  lapses_on: string;
  /** How the status was decided, in one sentence. */
  basis: string;
  links: AuditFileLink[];
  /** `mgmt` = a figure that only measures a gap; the handover PDF leaves it out. */
  summary: Array<{ label: string; value: string; mgmt?: true }>;
  tables: AuditFileTable[];
  scans: AuditFileScan[];
}

export interface AuditFile {
  section: string;
  today: string;
  days: number;
  since: string;
  counts: { present: number; expiring: number; missing: number; total: number };
  items: AuditFileItem[];
}

export interface AuditFileOptions {
  /** How many days of running logs to list. */
  days?: number;
  /** Rows per table. The page asks for a few, the PDF for many. */
  rowLimit?: number;
}

/* ══════════════════════════════════════════════════════════════════════════
 * SMALL HELPERS
 * ══════════════════════════════════════════════════════════════════════════ */

const RANK: Record<AuditFileStatus, number> = { present: 0, expiring: 1, missing: 2 };

function worst(...s: AuditFileStatus[]): AuditFileStatus {
  return s.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'present' as AuditFileStatus);
}

function s(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function plural(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : (many || `${one}s`)}`;
}

/** 'today', 'yesterday', 'N days ago' — for a business date. */
function ago(dateISO: string, today: string): string {
  const d = daysBetweenISO(dateISO, today);
  if (!Number.isFinite(d)) return dateISO;
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  return `${d} days ago`;
}

/** 'in N days' / 'today' / 'N days ago' for a date that lapses. */
function until(dateISO: string, today: string): string {
  const d = daysBetweenISO(today, dateISO);
  if (!Number.isFinite(d)) return dateISO;
  if (d === 0) return 'today';
  if (d > 0) return `in ${plural(d, 'day')}`;
  return `${plural(-d, 'day')} ago`;
}

/** First 10 characters of an ISO date-time, or '' — created_at is 'YYYY-MM-DD HH:MM:SS'. */
function dateOf(v: unknown): string {
  const t = s(v).slice(0, 10);
  return isISODate(t) ? t : '';
}

function earliest(dates: string[]): string {
  const ok = dates.filter((d) => isISODate(d)).sort();
  return ok[0] || '';
}

/** Which of the given tables are missing from this database. */
function absent(present: Set<string>, tables: string[]): string[] {
  return tables.filter((t) => !present.has(t));
}

const NOT_IN_DB = (tables: string[]) =>
  `The register this record is kept in (${tables.join(', ')}) has not been created in this copy of the database yet. ` +
  'Restart the application once and it will be there.';

/** Exclude voided rows and drafts — neither is a filed record. */
const LIVE = (alias: string) =>
  `${alias}.voided_at = '' AND ${alias}.status NOT IN ('void','draft')`;

function table(
  title: string,
  columns: AuditFileColumn[],
  all: AuditFileRow[],
  limit: number,
  empty = 'No records for these dates.',
): AuditFileTable {
  return {
    title, columns, rows: all.slice(0, limit), more: Math.max(0, all.length - limit), empty,
    handover_rows: all.filter((r) => r.in_handover).length,
  };
}

function row(cells: Array<string | number>, href = '', tone: AuditFileRow['tone'] = '', inHandover = true): AuditFileRow {
  return { cells: cells.map((c) => s(c)), href, tone, in_handover: inHandover };
}

/* ══════════════════════════════════════════════════════════════════════════
 * DOCUMENTS — read once, judged the same way for every paper record
 * ══════════════════════════════════════════════════════════════════════════ */

interface DocRow {
  id: string;
  doc_type: string;
  type_label: string;
  title: string;
  reference_no: string;
  issuer: string;
  issued_on: string;
  valid_from: string;
  expiry_date: string;
  state: 'no_expiry' | 'valid' | 'expiring' | 'expired';
  vendor_id: string;
  vendor_name: string;
  person_email: string;
  person_name: string;
  equipment_id: string;
  equipment_name: string;
  created_on: string;
  /** Images still stored. A row with 0 has no copy anyone can read. */
  stored: number;
  /** When the most recent image on it was removed, '' if none was. */
  dropped_at: string;
  scans: AuditFileScan[];
}

function docLabel(d: DocRow): string {
  return [d.title || d.type_label, d.reference_no ? `no. ${d.reference_no}` : ''].filter(Boolean).join(', ');
}

function readScans(db: Database.Database, entityTable: string, ids: string[], label: (id: string) => string): AuditFileScan[] {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return [];
  const out: AuditFileScan[] = [];
  for (let i = 0; i < uniq.length; i += 400) {
    const chunk = uniq.slice(i, i + 400);
    const rows = db.prepare(
      `SELECT id, entity_table, entity_id, mime, filename, size_bytes, caption, created_at, image_dropped_at,
              (data_uri <> '') AS has_image
         FROM fssai_attachments
        WHERE entity_table = ? AND entity_id IN (${chunk.map(() => '?').join(',')})
        ORDER BY created_at ASC, rowid ASC`,
    ).all(entityTable, ...chunk) as any[];
    for (const r of rows) {
      out.push({
        attachment_id: s(r.id),
        entity_table: s(r.entity_table),
        entity_id: s(r.entity_id),
        record_label: label(s(r.entity_id)),
        filename: s(r.filename),
        mime: s(r.mime),
        size_bytes: intOr(r.size_bytes),
        caption: s(r.caption),
        created_at: s(r.created_at),
        has_image: intOr(r.has_image) === 1,
        image_dropped_at: s(r.image_dropped_at),
      });
    }
  }
  return out;
}

function readDocs(ctx: Ctx, types: string[]): DocRow[] {
  const { db, today } = ctx;
  const rows = db.prepare(
    `SELECT d.id, d.doc_type, d.title, d.reference_no, d.issuer, d.issued_on, d.valid_from, d.expiry_date,
            d.reminder_days, d.vendor_id, d.person_email, d.equipment_id, d.created_at,
            (SELECT v.name FROM vendors v WHERE v.id = d.vendor_id) AS vendor_name,
            (SELECT u.name FROM users u WHERE lower(u.email) = lower(d.person_email) AND d.person_email <> '' LIMIT 1) AS person_name,
            ${ctx.present.has('fssai_equipment') ? `(SELECT e.name FROM fssai_equipment e WHERE e.id = d.equipment_id)` : `''`} AS equipment_name
       FROM fssai_documents d
      WHERE d.doc_type IN (${types.map(() => '?').join(',')})
        AND d.is_active = 1 AND ${LIVE('d')}
      ORDER BY (CASE WHEN d.expiry_date = '' THEN 1 ELSE 0 END) ASC, d.expiry_date DESC, d.created_at DESC`,
  ).all(...types) as any[];

  const docs: DocRow[] = rows.map((r) => {
    const reminder = Number.isFinite(Number(r.reminder_days)) ? Number(r.reminder_days) : FSSAI_DOC_REMINDER_DAYS;
    return {
      id: s(r.id),
      doc_type: s(r.doc_type),
      type_label: fssaiDocType(r.doc_type)?.label || s(r.doc_type),
      title: s(r.title),
      reference_no: s(r.reference_no),
      issuer: s(r.issuer),
      issued_on: s(r.issued_on),
      valid_from: s(r.valid_from),
      expiry_date: s(r.expiry_date),
      state: fssaiDocState(s(r.expiry_date), today, reminder),
      vendor_id: s(r.vendor_id),
      vendor_name: s(r.vendor_name),
      person_email: s(r.person_email),
      person_name: s(r.person_name),
      equipment_id: s(r.equipment_id),
      equipment_name: s(r.equipment_name),
      created_on: dateOf(r.created_at),
      stored: 0,
      dropped_at: '',
      scans: [],
    };
  });
  if (!docs.length || !ctx.present.has('fssai_attachments')) return docs;

  const byId = new Map(docs.map((d) => [d.id, d]));
  const scans = readScans(db, 'fssai_documents', docs.map((d) => d.id), (id) => {
    const d = byId.get(id);
    return d ? docLabel(d) : 'Document';
  });
  for (const sc of scans) {
    const d = byId.get(sc.entity_id);
    if (!d) continue;
    d.scans.push(sc);
    if (sc.has_image) d.stored++;
    else if (sc.image_dropped_at && sc.image_dropped_at > d.dropped_at) d.dropped_at = sc.image_dropped_at;
  }
  return docs;
}

const DOC_COLUMNS: AuditFileColumn[] = [
  { label: 'Document', width: 2.4 },
  { label: 'Number', width: 1.5 },
  { label: 'Issued by', width: 1.5 },
  { label: 'Valid from', width: 1 },
  { label: 'Expires', width: 1 },
  { label: 'State', width: 1 },
  { label: 'Copy', width: 0.9 },
];

const STATE_WORDS: Record<DocRow['state'], string> = {
  no_expiry: 'No expiry',
  valid: 'Valid',
  expiring: 'Expiring soon',
  expired: 'EXPIRED',
};

function docRows(docs: DocRow[], who?: (d: DocRow) => string): AuditFileRow[] {
  return docs.map((d) => row(
    [
      [...new Set([who ? who(d) : '', d.title || d.type_label].filter(Boolean))].join(' — '),
      d.reference_no,
      d.issuer,
      d.valid_from || d.issued_on,
      d.expiry_date || '—',
      STATE_WORDS[d.state],
      d.stored ? plural(d.stored, 'scan') : 'none',
    ],
    '/fssai/documents',
    d.state === 'expired' || !d.stored ? 'bad' : d.state === 'expiring' ? 'warn' : '',
    // A row with no copy is the number without the paper: not part of the file.
    d.stored > 0,
  ));
}

interface DocVerdict {
  status: AuditFileStatus;
  problems: string[];
  best: DocRow | null;
  lapses_on: string;
}

/**
 * The paper rule, applied to one set of documents that answer the same need
 * (one licence, one person's certificate, one unit's calibration).
 *   none on file → MISSING · all lapsed → MISSING · no copy attached → MISSING
 *   the best one inside its renewal window → EXPIRING · otherwise PRESENT.
 * "Best" = in force, with a copy, latest expiry (a dated one beats an undated
 * one, because an undated one cannot be judged either way).
 */
function judgeDocs(docs: DocRow[], what: string, today: string): DocVerdict {
  if (!docs.length) return { status: 'missing', problems: [`No ${what} is on file.`], best: null, lapses_on: '' };

  const inForce = docs.filter((d) => d.state !== 'expired');
  if (!inForce.length) {
    const last = [...docs].sort((a, b) => (a.expiry_date < b.expiry_date ? 1 : -1))[0];
    return {
      status: 'missing',
      problems: [`The ${what} on file (${docLabel(last)}) expired on ${last.expiry_date} — ${until(last.expiry_date, today)}.`],
      best: null,
      lapses_on: last.expiry_date,
    };
  }

  const withCopy = inForce.filter((d) => d.stored > 0);
  if (!withCopy.length) {
    const d = inForce[0];
    const why = d.dropped_at
      ? `its scan was removed on ${d.dropped_at.slice(0, 10)}`
      : 'no scan or photograph of it is attached';
    return {
      status: 'missing',
      problems: [`${docLabel(d)} is recorded, but ${why} — the file has the number, not the copy.`],
      best: d,
      lapses_on: d.expiry_date,
    };
  }

  const best = [...withCopy].sort((a, b) => {
    if (!!a.expiry_date !== !!b.expiry_date) return a.expiry_date ? -1 : 1;
    return a.expiry_date < b.expiry_date ? 1 : a.expiry_date > b.expiry_date ? -1 : 0;
  })[0];
  if (best.state === 'expiring') {
    return {
      status: 'expiring',
      problems: [`${docLabel(best)} expires on ${best.expiry_date} — ${until(best.expiry_date, today)}. Renew it before then.`],
      best,
      lapses_on: best.expiry_date,
    };
  }
  return { status: 'present', problems: [], best, lapses_on: best.expiry_date };
}

/**
 * A document that stands for a period but may carry no expiry date (a water
 * bill, a waste collector's receipt, a lab report): its own expiry when it has
 * one, otherwise `days` from when it was issued (or filed).
 */
function docCurrentUntil(d: DocRow, days: number): string {
  if (isISODate(d.expiry_date)) return d.expiry_date;
  const from = [d.valid_from, d.issued_on, d.created_on].find((x) => isISODate(x)) || '';
  return from ? addDaysISO(from, days) : '';
}

/** Judge "is there a current one" over dated periods, with the warning window. */
function judgePeriod(end: string, today: string, what: string, warnDays = WARN_DAYS): { status: AuditFileStatus; problems: string[] } {
  if (!isISODate(end)) return { status: 'missing', problems: [`No ${what} is on file.`] };
  const d = daysBetweenISO(today, end);
  if (d < 0) return { status: 'missing', problems: [`The latest ${what} ran out on ${end} — ${until(end, today)}.`] };
  if (d <= warnDays) return { status: 'expiring', problems: [`The latest ${what} runs out on ${end} — ${until(end, today)}.`] };
  return { status: 'present', problems: [] };
}

/* ══════════════════════════════════════════════════════════════════════════
 * RUNNING LOGS — judged on how old the last entry is
 * ══════════════════════════════════════════════════════════════════════════ */

function judgeLog(
  latest: string,
  today: string,
  cadence: { fresh: number; stale: number; words: string },
  what: string,
): { status: AuditFileStatus; problems: string[] } {
  if (!isISODate(latest)) return { status: 'missing', problems: [`No ${what} has been recorded.`] };
  const age = daysBetweenISO(latest, today);
  if (!Number.isFinite(age)) return { status: 'missing', problems: [`The last ${what} has an unreadable date (${latest}).`] };
  if (age > cadence.stale) {
    return { status: 'missing', problems: [`Nothing recorded for ${plural(age, 'day')} — the last ${what} was on ${latest}.`] };
  }
  if (age > cadence.fresh) {
    return {
      status: 'expiring',
      problems: [`The last ${what} was on ${latest} (${ago(latest, today)}). This log is kept ${cadence.words}, so it is lapsing.`],
    };
  }
  return { status: 'present', problems: [] };
}

/**
 * Where a PERIODIC register's list starts: monthly pest visits and quarterly
 * services are not daily logs, so a 7- or 30-day window would print a file
 * with last month's visit missing. They list at least the last quarter.
 */
function periodicFrom(ctx: Ctx): string {
  const quarter = addDaysISO(ctx.today, -(PERIODIC_DAYS - 1));
  return quarter < ctx.since ? quarter : ctx.since;
}

function logBasis(c: { fresh: number; stale: number; words: string }): string {
  return `Kept ${c.words}. PRESENT when the last entry is at most ${plural(c.fresh, 'day')} old, EXPIRING up to ${plural(c.stale, 'day')}, MISSING after that or when there is none.`;
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE 20 RECORDS
 * ══════════════════════════════════════════════════════════════════════════ */

interface Ctx {
  db: Database.Database;
  today: string;
  since: string;
  days: number;
  limit: number;
  present: Set<string>;
}

type Part = Omit<AuditFileItem, 'n' | 'key' | 'title'>;

function blank(): Part {
  return {
    status: 'missing', held: false, headline: '', problems: [], todo: '', lapses_on: '', basis: '',
    links: [], summary: [], tables: [], scans: [],
  };
}

const DOCS_LINK: AuditFileLink = { href: '/fssai/documents', label: 'Documents & Certificates' };

/** A single-paper record: one kind of document, copy required. */
function paperRecord(
  ctx: Ctx,
  types: string[],
  what: string,
  todo: string,
  extra?: { basis?: string; links?: AuditFileLink[] },
): Part {
  const p = blank();
  p.links = [DOCS_LINK, ...(extra?.links || [])];
  p.basis = extra?.basis ||
    `From Documents & Certificates: PRESENT when one is in force with a copy attached, EXPIRING inside its own renewal window, MISSING when none is on file, it has expired, or no copy is attached.`;
  const miss = absent(ctx.present, ['fssai_documents']);
  if (miss.length) { p.problems = [NOT_IN_DB(miss)]; p.todo = todo; return p; }

  const docs = readDocs(ctx, types);
  const v = judgeDocs(docs, what, ctx.today);
  p.status = v.status;
  p.problems = v.problems;
  p.lapses_on = v.lapses_on;
  p.scans = docs.flatMap((d) => d.scans);
  p.tables = [table('On file', DOC_COLUMNS, docRows(docs), ctx.limit, 'Nothing of this kind is on file.')];
  const b = v.best;
  // Only a paper that RENEWS (FSSAI_DOC_TYPES.renews) has an expiry worth
  // talking about; a photograph of the display board does not lapse.
  const renews = types.some((t) => !!fssaiDocType(t)?.renews);
  p.headline = b
    ? [docLabel(b), b.issuer ? `issued by ${b.issuer}` : '',
      b.expiry_date ? `valid until ${b.expiry_date}` : renews ? 'no expiry date recorded' : '',
      plural(b.stored, 'scan')].filter(Boolean).join(' · ')
    : docs.length ? `${plural(docs.length, 'document')} on file, none usable` : 'Nothing on file';
  p.summary = [
    { label: 'On file', value: String(docs.length) },
    { label: 'With a copy', value: String(docs.filter((d) => d.stored > 0).length), mgmt: true },
    ...(renews ? [{ label: 'Expires', value: b?.expiry_date || '—' }] : []),
  ];
  if (b && !b.expiry_date && renews && v.status === 'present') {
    p.headline += ' · add the expiry date so this page can warn before it lapses';
  }
  if (p.status !== 'present') p.todo = todo;
  return p;
}

/* 1 ─ FSSAI licence copy */
function fssaiLicence(ctx: Ctx): Part {
  return paperRecord(ctx, ['fssai_licence'], 'FSSAI licence',
    'File the licence under Documents & Certificates as "FSSAI licence or registration", with its number and expiry, and attach a photograph or scan of the licence itself.');
}

/* 2 ─ FSDB photograph */
function fsdbPhoto(ctx: Ctx): Part {
  return paperRecord(ctx, ['fsdb_photo'], 'FSDB photograph',
    'Photograph the Food Safety Display Board where customers can read it, and file it under Documents & Certificates as "FSDB photograph (Food Safety Display Board)".',
    { basis: 'From Documents & Certificates: PRESENT when a photograph of the display board is on file with the image still stored, MISSING otherwise.' });
}

/* 3 ─ GHMC licence */
function ghmcLicence(ctx: Ctx): Part {
  const p = paperRecord(ctx, ['trade_licence'], 'GHMC licence (filed as "Trade licence")',
    'File the GHMC trade licence under Documents & Certificates as "Trade licence", with its number and expiry, and attach a scan.');
  p.basis = 'The GHMC licence is filed as "Trade licence" in Documents & Certificates. ' + p.basis.replace(/^From Documents & Certificates: /, '');
  return p;
}

/* 4 ─ Water test report / water bill */
function water(ctx: Ctx): Part {
  const p = blank();
  p.links = [{ href: '/fssai/water-ice', label: 'Water & Ice Checks' }, DOCS_LINK];
  p.basis =
    `Either half satisfies the line. A laboratory report counts until the next test date written on it (or ${CURRENCY_DAYS.water_test} days after the report when none is written); ` +
    `a filed water-test document until its expiry; a municipal water bill for ${CURRENCY_DAYS.water_bill} days from its date. EXPIRING inside ${WARN_DAYS} days of the end.`;
  const todo =
    'Get the water tested by a laboratory and record the report under Water & Ice Checks (kind "Lab report"), or file the latest municipal water bill under Documents & Certificates as "Municipal water bill".';

  const ends: Array<{ end: string; label: string }> = [];
  const rows: AuditFileRow[] = [];
  let held = 0;

  if (ctx.present.has('fssai_water_tests')) {
    const labs = ctx.db.prepare(
      `SELECT id, business_date, lab_name, lab_licence_no, report_no, sample_date, report_date, result, next_due_date, is_fail
         FROM fssai_water_tests w
        WHERE w.test_kind = 'lab_report' AND ${LIVE('w')}
        ORDER BY business_date DESC, created_at DESC`,
    ).all() as any[];
    held += labs.length;
    for (const r of labs) {
      const from = [s(r.report_date), s(r.sample_date), s(r.business_date)].find((x) => isISODate(x)) || '';
      const end = isISODate(s(r.next_due_date)) ? s(r.next_due_date) : from ? addDaysISO(from, CURRENCY_DAYS.water_test) : '';
      if (end) ends.push({ end, label: `laboratory water report${r.report_no ? ` no. ${s(r.report_no)}` : ''}` });
      rows.push(row(
        ['Lab report', [s(r.lab_name), s(r.lab_licence_no)].filter(Boolean).join(' · '), s(r.report_no), from, end || '—',
          intOr(r.is_fail) ? 'FAIL' : (s(r.result) || 'Recorded')],
        '/fssai/water-ice', intOr(r.is_fail) ? 'bad' : '',
      ));
    }
    p.scans.push(...readScans(ctx.db, 'fssai_water_tests', labs.map((r) => s(r.id)), () => 'Laboratory water report'));
  }

  if (ctx.present.has('fssai_documents')) {
    const docs = readDocs(ctx, ['water_test', 'water_bill']);
    held += docs.length;
    for (const d of docs) {
      const isBill = d.doc_type === 'water_bill';
      const end = docCurrentUntil(d, isBill ? CURRENCY_DAYS.water_bill : CURRENCY_DAYS.water_test);
      // A document counts only with its copy (see the header).
      if (end && d.stored > 0) ends.push({ end, label: isBill ? `water bill (${docLabel(d)})` : `water test report (${docLabel(d)})` });
      rows.push(row(
        [isBill ? 'Water bill' : 'Water test document', d.issuer, d.reference_no, d.issued_on || d.valid_from || d.created_on, end || '—',
          d.stored ? plural(d.stored, 'scan') : 'no copy attached'],
        '/fssai/documents', d.stored ? '' : 'bad', d.stored > 0,
      ));
      p.scans.push(...d.scans);
    }
  }

  const miss = absent(ctx.present, ['fssai_water_tests', 'fssai_documents']);
  if (miss.length === 2) { p.problems = [NOT_IN_DB(miss)]; p.todo = todo; return p; }

  ends.sort((a, b) => (a.end < b.end ? 1 : -1));
  const best = ends[0];
  const v = judgePeriod(best?.end || '', ctx.today, 'water test report or water bill');
  p.status = v.status;
  p.problems = v.problems;
  if (!best && held) p.problems = ['Water records are on file, but none is a laboratory report with a date or a filed document with a copy attached.'];
  p.lapses_on = best?.end || '';
  p.headline = best ? `Current: ${best.label}, good until ${best.end}` : held ? `${plural(held, 'record')} on file, none current` : 'Nothing on file';
  p.summary = [
    { label: 'On file', value: String(held) },
    { label: 'Good until', value: best?.end || '—' },
  ];
  p.tables = [table('Water reports and bills', [
    { label: 'Kind', width: 1.3 }, { label: 'Laboratory / issuer', width: 2 }, { label: 'Report / bill no.', width: 1.3 },
    { label: 'Dated', width: 1 }, { label: 'Good until', width: 1 }, { label: 'Result / copy', width: 1.2 },
  ], rows, ctx.limit, 'Nothing of this kind is on file.')];
  if (p.status !== 'present') p.todo = todo;
  return p;
}

/* 5 ─ Pest-control agreement + reports */
function pestControl(ctx: Ctx): Part {
  const p = blank();
  p.links = [{ href: '/fssai/pest-control', label: 'Pest Control Logs' }, DOCS_LINK];
  p.basis =
    `Both halves are needed. The agreement: a pest-control contract in force with a copy attached. The reports: a completed visit whose next visit date has not passed ` +
    `(or within ${CURRENCY_DAYS.pest_visit} days when the technician wrote none). EXPIRING when the contract is inside its renewal window or the next visit is due within ${PEST_WARN_DAYS} days.`;
  const todo =
    'File the pest-control agreement under Documents & Certificates as "Pest control contract" with a scan, and record every visit, with the technician\'s report, under Pest Control Logs.';
  const miss = absent(ctx.present, ['fssai_documents', 'fssai_pest_services']);
  if (miss.length) { p.problems = [NOT_IN_DB(miss)]; p.todo = todo; return p; }

  const docs = readDocs(ctx, ['pest_contract']);
  const c = judgeDocs(docs, 'pest-control agreement', ctx.today);

  const visits = ctx.db.prepare(
    `SELECT id, service_no, business_date, vendor_name, agency_licence_no, technician_name, service_kind, areas_covered,
            findings, report_no, next_due_date, status
       FROM fssai_pest_services ps
      WHERE ps.voided_at = '' AND ps.status = 'completed'
      ORDER BY business_date DESC, created_at DESC`,
  ).all() as any[];
  const last = visits[0];
  const end = last ? (isISODate(s(last.next_due_date)) ? s(last.next_due_date) : addDaysISO(s(last.business_date), CURRENCY_DAYS.pest_visit)) : '';
  let r: { status: AuditFileStatus; problems: string[] };
  if (!last) r = { status: 'missing', problems: ['No completed pest-control visit is recorded, so there is no service report.'] };
  else {
    const d = daysBetweenISO(ctx.today, end);
    if (d < 0) r = { status: 'missing', problems: [`The last visit was on ${s(last.business_date)}; the next was due on ${end} (${until(end, ctx.today)}) and no report for it is recorded.`] };
    else if (d <= PEST_WARN_DAYS) r = { status: 'expiring', problems: [`The next pest-control visit is due on ${end} — ${until(end, ctx.today)}. Record its report when it happens.`] };
    else r = { status: 'present', problems: [] };
  }

  p.status = worst(c.status, r.status);
  p.problems = [...c.problems, ...r.problems];
  p.lapses_on = earliest([c.lapses_on, end]);
  p.headline = [
    c.best ? `Agreement: ${docLabel(c.best)}${c.best.expiry_date ? `, until ${c.best.expiry_date}` : ''}` : 'No agreement in force',
    last ? `last visit ${s(last.business_date)} by ${s(last.vendor_name) || 'the agency'}` : 'no visit recorded',
  ].join(' · ');
  p.summary = [
    { label: 'Agreement', value: c.best ? (c.best.expiry_date || 'no expiry') : '—' },
    { label: 'Visits recorded', value: String(visits.length) },
    { label: 'Last visit', value: last ? s(last.business_date) : '—' },
    { label: 'Next due', value: end || '—' },
  ];
  const from = periodicFrom(ctx);
  const inWindow = visits.filter((v) => s(v.business_date) >= from);
  p.tables = [
    table('Agreement', DOC_COLUMNS, docRows(docs), ctx.limit, 'No agreement is on file.'),
    table(`Service reports from ${from}`, [
      { label: 'Date', width: 0.9 }, { label: 'Agency', width: 1.5 }, { label: 'Report no.', width: 1 },
      { label: 'Technician', width: 1.1 }, { label: 'Areas', width: 1.6 }, { label: 'Findings', width: 2 }, { label: 'Next due', width: 0.9 },
    ], inWindow.map((v) => row([
      s(v.business_date), [s(v.vendor_name), s(v.agency_licence_no)].filter(Boolean).join(' · '), s(v.report_no) || s(v.service_no),
      s(v.technician_name), s(v.areas_covered), s(v.findings), s(v.next_due_date),
    ], '/fssai/pest-control')), ctx.limit),
  ];
  p.scans = [
    ...docs.flatMap((d) => d.scans),
    ...readScans(ctx.db, 'fssai_pest_services', inWindow.slice(0, 6).map((v) => s(v.id)),
      (id) => { const v = visits.find((x) => s(x.id) === id); return v ? `Pest-control report ${s(v.report_no) || s(v.service_no)} (${s(v.business_date)})` : 'Pest-control report'; }),
  ];
  if (p.status !== 'present') p.todo = todo;
  return p;
}

/* 6, 7 ─ certificates held per person */
function perPerson(ctx: Ctx, docType: string, what: string, todo: string): Part {
  const p = blank();
  p.links = [DOCS_LINK, { href: '/fssai/hygiene', label: 'Personal Hygiene' }];
  p.basis =
    `Each person's latest certificate is judged on its own: in force with a copy → PRESENT, inside its renewal window → EXPIRING, expired or no copy → MISSING. ` +
    `The record is only as good as its worst person. Certificates are filed against a person's sign-in email.`;
  const miss = absent(ctx.present, ['fssai_documents']);
  if (miss.length) { p.problems = [NOT_IN_DB(miss)]; p.todo = todo; return p; }

  const docs = readDocs(ctx, [docType]);
  const groups = new Map<string, DocRow[]>();
  for (const d of docs) {
    const k = (d.person_email || `doc:${d.id}`).toLowerCase();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(d);
  }
  const who = (d: DocRow) => d.person_name || d.person_email || '(no person named)';
  let status: AuditFileStatus = groups.size ? 'present' : 'missing';
  const problems: string[] = groups.size ? [] : [`No ${what} is on file for anybody.`];
  const lapses: string[] = [];
  let covered = 0;
  for (const list of groups.values()) {
    const v = judgeDocs(list, what, ctx.today);
    status = worst(status, v.status);
    if (v.status === 'present') covered++;
    if (v.status !== 'present') problems.push(`${who(list[0])}: ${v.problems[0] || ''}`);
    if (v.lapses_on) lapses.push(v.lapses_on);
  }
  p.status = status;
  p.problems = problems;
  p.lapses_on = earliest(lapses);
  p.headline = groups.size
    ? `${plural(groups.size, 'person', 'people')} on file · ${covered} fully in order`
    : 'Nothing on file';
  p.summary = [
    { label: 'People on file', value: String(groups.size) },
    { label: 'In order', value: String(covered) },
    { label: 'Next to lapse', value: p.lapses_on || '—' },
  ];
  p.tables = [table('Certificates on file', [{ label: 'Person — certificate', width: 2.6 }, ...DOC_COLUMNS.slice(1)], docRows(docs, who), ctx.limit,
    'Nothing of this kind is on file.')];
  p.scans = docs.flatMap((d) => d.scans.map((sc) => ({ ...sc, record_label: `${who(d)} — ${sc.record_label}` })));
  if (p.status !== 'present') p.todo = todo;
  return p;
}

/* 8 ─ Approved vendor list */
function vendors(ctx: Ctx): Part {
  const p = blank();
  p.links = [{ href: '/vendors', label: 'Vendors — Approved vendor list' }, DOCS_LINK];
  p.basis =
    'From the approved-vendor register on Vendors. PRESENT when at least one supplier is marked approved and every approved supplier has an FSSAI licence in force on file; ' +
    'EXPIRING when an approved supplier\'s licence is inside its renewal window; MISSING when no supplier is approved, or an approved supplier\'s licence has expired or is not on file.';
  const todo =
    'On Vendors, open the Approved vendor list, mark each supplier you buy food from as approved (and what they supply), and file each one\'s FSSAI licence with a scan.';
  if (!vendorRegisterReady(ctx.db)) {
    p.problems = ['The approved-vendor register columns are not in this copy of the database yet. Restart the application once and they will be there.'];
    p.todo = todo;
    return p;
  }
  const approved = ctx.db.prepare(
    `SELECT id, name, fssai_supplies, fssai_approval_by, fssai_approval_at
       FROM vendors
      WHERE fssai_approval = 'approved' AND IFNULL(is_active, 1) = 1
      ORDER BY name COLLATE NOCASE`,
  ).all() as any[];
  const totals = ctx.db.prepare(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN fssai_approval = 'not_approved' THEN 1 ELSE 0 END) AS refused,
            SUM(CASE WHEN fssai_approval = '' THEN 1 ELSE 0 END) AS unreviewed
       FROM vendors WHERE IFNULL(is_active, 1) = 1`,
  ).get() as any;
  const lic = supplierLicencesByVendor(ctx.db, ctx.today, approved.map((v) => s(v.id)));

  const expired: string[] = [];
  const none: string[] = [];
  const soon: string[] = [];
  const lapses: string[] = [];
  const rows = approved.map((v) => {
    const l = lic.get(s(v.id)) || null;
    if (!l) none.push(s(v.name));
    else if (l.state === 'expired') expired.push(`${s(v.name)} (expired ${l.expiry_date})`);
    else if (l.state === 'expiring') { soon.push(`${s(v.name)} (expires ${l.expiry_date})`); lapses.push(l.expiry_date); }
    else if (l.expiry_date) lapses.push(l.expiry_date);
    return row([
      s(v.name), s(v.fssai_supplies), [s(v.fssai_approval_by), s(v.fssai_approval_at).slice(0, 10)].filter(Boolean).join(' · '),
      l?.reference_no || '—', l?.expiry_date || '—', l ? STATE_WORDS[l.state] : 'Not on file',
    ], '/vendors', !l || l.state === 'expired' ? 'bad' : l.state === 'expiring' ? 'warn' : '');
  });

  const problems: string[] = [];
  let status: AuditFileStatus = 'present';
  if (!approved.length) {
    status = 'missing';
    problems.push(`No supplier is marked approved yet (${plural(intOr(totals?.unreviewed), 'supplier')} not reviewed).`);
  }
  if (expired.length) { status = 'missing'; problems.push(`Approved, but their FSSAI licence has expired: ${expired.join(', ')}.`); }
  if (none.length) { status = 'missing'; problems.push(`Approved, but no FSSAI licence is on file: ${none.join(', ')}.`); }
  if (soon.length) { status = worst(status, 'expiring'); problems.push(`Licence expiring soon: ${soon.join(', ')}.`); }

  p.status = status;
  p.problems = problems;
  p.lapses_on = earliest(lapses);
  p.headline = approved.length
    ? `${plural(approved.length, 'approved supplier')} · ${approved.length - none.length - expired.length} with a licence in force`
    : 'No supplier approved yet';
  p.summary = [
    { label: 'Approved', value: String(approved.length) },
    { label: 'Not approved', value: String(intOr(totals?.refused)), mgmt: true },
    { label: 'Not reviewed', value: String(intOr(totals?.unreviewed)), mgmt: true },
  ];
  p.tables = [table('Approved suppliers', [
    { label: 'Supplier', width: 2 }, { label: 'Approved to supply', width: 2 }, { label: 'Approved by', width: 1.8 },
    { label: 'FSSAI licence', width: 1.4 }, { label: 'Expires', width: 0.9 }, { label: 'Licence', width: 0.9 },
  ], rows, ctx.limit, 'No supplier is marked approved.')];
  if (p.status !== 'present') p.todo = todo;
  return p;
}

/* 9 ─ Receiving checklist */
function receiving(ctx: Ctx): Part {
  const p = blank();
  p.links = [{ href: '/fssai/receiving', label: 'Receiving/Receivables Quality Check' }];
  p.basis = logBasis(CADENCE.receiving);
  const todo = 'Check every delivery at the door on Receiving/Receivables Quality Check and submit it.';
  const miss = absent(ctx.present, ['fssai_receiving_checks']);
  if (miss.length) { p.problems = [NOT_IN_DB(miss)]; p.todo = todo; return p; }

  const latest = s((ctx.db.prepare(`SELECT MAX(business_date) AS d FROM fssai_receiving_checks rc WHERE ${LIVE('rc')}`).get() as any)?.d);
  const rows = ctx.db.prepare(
    `SELECT id, business_date, check_no, vendor_name, grn_number, supplier_licence_no, vehicle_temp_c,
            line_count, fail_count, rejected_count, outcome, checked_name, checked_by
       FROM fssai_receiving_checks rc
      WHERE ${LIVE('rc')} AND business_date >= ? AND business_date <= ?
      ORDER BY business_date DESC, received_at DESC`,
  ).all(ctx.since, ctx.today) as any[];
  const v = judgeLog(latest, ctx.today, CADENCE.receiving, 'delivery check');
  p.status = v.status;
  p.problems = v.problems;
  p.headline = latest ? `${plural(rows.length, 'delivery', 'deliveries')} checked since ${ctx.since} · last on ${latest}` : 'No delivery check recorded';
  p.summary = [
    { label: 'Checked', value: String(rows.length) },
    { label: 'With a failed line', value: String(rows.filter((r) => intOr(r.fail_count) > 0).length) },
    { label: 'Items rejected', value: String(rows.reduce((a, r) => a + intOr(r.rejected_count), 0)) },
    { label: 'Last check', value: latest || '—' },
  ];
  p.tables = [table(`Deliveries checked from ${ctx.since}`, [
    { label: 'Date', width: 0.9 }, { label: 'Check no.', width: 1 }, { label: 'Supplier', width: 1.8 }, { label: 'GRN', width: 0.9 },
    { label: 'Supplier licence', width: 1.3 }, { label: 'Vehicle °C', width: 0.8, align: 'right' }, { label: 'Lines', width: 0.6, align: 'right' },
    { label: 'Failed', width: 0.6, align: 'right' }, { label: 'Rejected', width: 0.7, align: 'right' }, { label: 'Checked by', width: 1.3 },
  ], rows.map((r) => row([
    s(r.business_date), s(r.check_no), s(r.vendor_name), s(r.grn_number), s(r.supplier_licence_no), numOrBlank(r.vehicle_temp_c, 1),
    intOr(r.line_count), intOr(r.fail_count), intOr(r.rejected_count), s(r.checked_name || r.checked_by),
  ], '/fssai/receiving', intOr(r.fail_count) > 0 ? 'bad' : '')), ctx.limit)];
  if (p.status !== 'present') p.todo = todo;
  return p;
}

/* 10, 11 ─ temperature logs, by kind */
function rangeWords(min: unknown, max: unknown, uom: string): string {
  const a = min === null || min === undefined || min === '' ? '' : String(min);
  const b = max === null || max === undefined || max === '' ? '' : String(max);
  if (a && b) return `${a} to ${b} ${uom}`.trim();
  if (b) return `at most ${b} ${uom}`.trim();
  if (a) return `at least ${a} ${uom}`.trim();
  return '';
}

function tempVerdict(r: any): string {
  if (intOr(r.is_judged, 1) === 0) return 'Not judged';
  return intOr(r.is_fail) ? 'FAIL' : 'In range';
}

function tempLog(ctx: Ctx, key: 'cold_temps' | 'cooking_temps', kinds: string[], what: string, todo: string, links: AuditFileLink[]): Part {
  const p = blank();
  const cadence = CADENCE[key];
  p.links = links;
  p.basis = logBasis(cadence) + (key === 'cold_temps' ? ' A unit read in this period that has gone quiet for longer than that makes it EXPIRING too.' : '');
  const miss = absent(ctx.present, ['fssai_temperature_logs']);
  if (miss.length) { p.problems = [NOT_IN_DB(miss)]; p.todo = todo; return p; }

  const marks = kinds.map(() => '?').join(',');
  const latest = s((ctx.db.prepare(
    `SELECT MAX(business_date) AS d FROM fssai_temperature_logs t WHERE t.log_kind IN (${marks}) AND ${LIVE('t')}`,
  ).get(...kinds) as any)?.d);
  const rows = ctx.db.prepare(
    `SELECT id, business_date, reading_at, log_kind, equipment_label, area_label, item_label, value_num, uom, decimals,
            min_used, max_used, is_fail, is_judged, action_taken, recorded_name, recorded_by, elapsed_minutes, max_minutes_used
       FROM fssai_temperature_logs t
      WHERE t.log_kind IN (${marks}) AND ${LIVE('t')} AND business_date >= ? AND business_date <= ?
      ORDER BY business_date DESC, reading_at DESC`,
  ).all(...kinds, ctx.since, ctx.today) as any[];

  const v = judgeLog(latest, ctx.today, cadence, what);
  let status = v.status;
  const problems = [...v.problems];
  if (key === 'cold_temps' && rows.length) {
    // A unit that WAS being read and has stopped is the gap an inspector finds
    // by turning the pages — the overall "last entry" hides it.
    const lastByUnit = new Map<string, string>();
    for (const r of rows) {
      const u = s(r.equipment_label || r.area_label) || '(unit not named)';
      if (!lastByUnit.has(u) || s(r.business_date) > lastByUnit.get(u)!) lastByUnit.set(u, s(r.business_date));
    }
    const quiet = [...lastByUnit.entries()].filter(([, d]) => daysBetweenISO(d, ctx.today) > cadence.fresh);
    if (quiet.length && status === 'present') status = 'expiring';
    if (quiet.length) problems.push(`Not read since: ${quiet.map(([u, d]) => `${u} (${d})`).join(', ')}.`);
  }
  const fails = rows.filter((r) => intOr(r.is_fail) === 1);
  const unactioned = fails.filter((r) => !s(r.action_taken));
  if (unactioned.length) problems.push(`${plural(unactioned.length, 'out-of-range reading')} in this period ${unactioned.length === 1 ? 'has' : 'have'} no action written against ${unactioned.length === 1 ? 'it' : 'them'}.`);

  p.status = status;
  p.problems = problems;
  p.headline = latest ? `${plural(rows.length, 'reading')} since ${ctx.since} · last on ${latest}` : `No ${what} recorded`;
  p.summary = [
    { label: 'Readings', value: String(rows.length) },
    { label: 'Out of range', value: String(fails.length) },
    { label: 'Not judged', value: String(rows.filter((r) => intOr(r.is_judged, 1) === 0).length), mgmt: true },
    { label: 'Last reading', value: latest || '—' },
  ];
  const isCold = key === 'cold_temps';
  p.tables = [table(`Readings from ${ctx.since}`, [
    { label: 'Date', width: 1.05 }, { label: 'Time', width: 0.6 },
    { label: isCold ? 'Unit' : 'What', width: isCold ? 1.7 : 1.5 }, { label: isCold ? 'Area' : 'Kind', width: 0.9 },
    ...(isCold ? [] : [{ label: 'Minutes', width: 0.8 }]),
    { label: 'Reading', width: 0.8, align: 'right' as const }, { label: 'Range applied', width: 1.15 }, { label: 'Verdict', width: 1.05 },
    { label: 'Action taken', width: 1.4 }, { label: 'By', width: 1 },
  ], rows.map((r) => {
    const reading = numOrBlank(r.value_num, intOr(r.decimals, 1));
    const mins = intOr(r.elapsed_minutes) ? `${intOr(r.elapsed_minutes)}${intOr(r.max_minutes_used) ? ` of ${intOr(r.max_minutes_used)}` : ''}` : '';
    return row([
      s(r.business_date), s(r.reading_at).slice(11, 16) || s(r.reading_at).slice(0, 5),
      isCold ? s(r.equipment_label || r.area_label) : [s(r.item_label), s(r.equipment_label || r.area_label)].filter(Boolean).join(' · '),
      isCold ? s(r.area_label) : fssaiTempLogKindLabel(r.log_kind),
      ...(isCold ? [] : [mins]),
      reading ? `${reading} ${s(r.uom)}`.trim() : '—', rangeWords(r.min_used, r.max_used, s(r.uom)), tempVerdict(r),
      s(r.action_taken), s(r.recorded_name || r.recorded_by),
    ], '/fssai/temperature', intOr(r.is_fail) ? 'bad' : '');
  }), ctx.limit)];
  if (p.status !== 'present') p.todo = todo;
  return p;
}

/* 12, 13, 18 ─ checklist rounds */
function runsOf(ctx: Ctx, where: string, args: any[]): { latest: string; rows: any[] } {
  const latest = s((ctx.db.prepare(
    `SELECT MAX(r.business_date) AS d FROM fssai_runs r JOIN fssai_templates t ON t.id = r.template_id
      WHERE r.status IN ('submitted','verified') AND r.voided_at = '' AND (${where})`,
  ).get(...args) as any)?.d);
  const rows = ctx.db.prepare(
    `SELECT r.id, r.business_date, r.shift, r.target_label, r.status, r.outcome, r.answered_count, r.total_count,
            r.fail_count, r.recorded_name, r.recorded_by, r.signed_by, t.name AS template_name, t.code AS template_code
       FROM fssai_runs r JOIN fssai_templates t ON t.id = r.template_id
      WHERE r.status IN ('submitted','verified') AND r.voided_at = '' AND (${where})
        AND r.business_date >= ? AND r.business_date <= ?
      ORDER BY r.business_date DESC, r.started_at DESC`,
  ).all(...args, ctx.since, ctx.today) as any[];
  return { latest, rows };
}

const RUN_COLUMNS: AuditFileColumn[] = [
  { label: 'Date', width: 0.9 }, { label: 'Checklist', width: 2.8 }, { label: 'Shift', width: 0.8 }, { label: 'Answered', width: 0.8, align: 'right' },
  { label: 'Failed', width: 0.6, align: 'right' }, { label: 'Status', width: 0.9 }, { label: 'Recorded by', width: 1.3 }, { label: 'Signed', width: 1.1 },
];

function runRows(rows: any[]): AuditFileRow[] {
  return rows.map((r) => row([
    s(r.business_date), s(r.template_name), s(r.shift), `${intOr(r.answered_count)}/${intOr(r.total_count)}`, intOr(r.fail_count),
    s(r.status) === 'verified' ? 'Verified' : 'Submitted', s(r.recorded_name || r.recorded_by), s(r.signed_by) ? 'Signed' : '',
  ], `/fssai/checklists/run/${encodeURIComponent(s(r.id))}`, intOr(r.fail_count) > 0 ? 'bad' : ''));
}

function templatesSetUp(ctx: Ctx, where: string, args: any[]): number {
  return intOr((ctx.db.prepare(
    `SELECT COUNT(*) AS n FROM fssai_templates t WHERE t.is_active = 1 AND t.status = 'published' AND (${where})`,
  ).get(...args) as any)?.n);
}

function checklistRecord(
  ctx: Ctx,
  key: 'cleaning' | 'pest_monitoring' | 'fifo',
  where: string,
  args: any[],
  what: string,
  todo: string,
  links: AuditFileLink[],
  notSetUp: string,
): Part {
  const p = blank();
  const cadence = CADENCE[key];
  p.links = links;
  p.basis = logBasis(cadence) + ' Only submitted or verified rounds count; a round still in progress is not a record.';
  const miss = absent(ctx.present, ['fssai_runs', 'fssai_templates', 'fssai_sections']);
  if (miss.length) { p.problems = [NOT_IN_DB(miss)]; p.todo = todo; return p; }

  const { latest, rows } = runsOf(ctx, where, args);
  const v = judgeLog(latest, ctx.today, cadence, what);
  p.status = v.status;
  p.problems = [...v.problems];
  if (!latest && templatesSetUp(ctx, where, args) === 0) p.problems.push(notSetUp);
  p.headline = latest ? `${plural(rows.length, 'round')} since ${ctx.since} · last on ${latest}` : `No ${what} recorded`;
  const byTemplate = new Map<string, string>();
  for (const r of rows) if (!byTemplate.has(s(r.template_name))) byTemplate.set(s(r.template_name), s(r.business_date));
  p.summary = [
    { label: 'Rounds', value: String(rows.length) },
    { label: 'With a failure', value: String(rows.filter((r) => intOr(r.fail_count) > 0).length) },
    { label: 'Verified', value: String(rows.filter((r) => s(r.status) === 'verified').length) },
    { label: 'Last round', value: latest || '—' },
  ];
  p.tables = [table(`Rounds from ${ctx.since}`, RUN_COLUMNS, runRows(rows), ctx.limit)];
  if (p.status !== 'present') p.todo = todo;
  return p;
}

function cleaning(ctx: Ctx): Part {
  return checklistRecord(ctx, 'cleaning', `t.module_key = ?`, ['cleaning'], 'cleaning round',
    'Run the cleaning checklists on Cleaning & Sanitation — the daily kitchen clean, the washroom rounds and the weekly deep clean — and submit each one.',
    [{ href: '/fssai/cleaning', label: 'Cleaning & Sanitation' }],
    'No cleaning checklist is published. An administrator publishes the ready-made ones under FSSAI Settings.');
}

/** A template with a Pests section — the daily look for pests is part of that round. */
const PEST_TEMPLATE_WHERE =
  `EXISTS (SELECT 1 FROM fssai_sections sx WHERE sx.template_id = t.id AND sx.is_active = 1
            AND (sx.code = 'PEST' OR lower(sx.title) LIKE '%pest%'))`;

function pestMonitoring(ctx: Ctx): Part {
  const p = checklistRecord(ctx, 'pest_monitoring', PEST_TEMPLATE_WHERE, [], 'pest check',
    'Run the daily kitchen cleaning round — its Pests section is the daily pest look — and log every sighting under Pest Control Logs.',
    [{ href: '/fssai/pest-control', label: 'Pest Control Logs' }, { href: '/fssai/cleaning', label: 'Cleaning & Sanitation' }],
    'No published checklist has a Pests section. An administrator publishes the ready-made daily kitchen cleaning checklist under FSSAI Settings.');
  p.basis = 'The daily pest look is the Pests section of a checklist round (the daily kitchen clean carries one). ' + p.basis +
    ' Sightings and the bait-station register are listed alongside it.';
  if (ctx.present.has('fssai_pest_sightings')) {
    const sightings = ctx.db.prepare(
      `SELECT business_date, pest_type, evidence_kind, location_label, severity, immediate_action, closed_at
         FROM fssai_pest_sightings ps
        WHERE ps.voided_at = '' AND ps.status <> 'void' AND business_date >= ? AND business_date <= ?
        ORDER BY business_date DESC`,
    ).all(ctx.since, ctx.today) as any[];
    const open = sightings.filter((x) => !s(x.closed_at));
    if (open.length) p.problems.push(`${plural(open.length, 'pest sighting')} in this period ${open.length === 1 ? 'is' : 'are'} still open.`);
    if (open.length && p.status === 'present') p.status = 'expiring';
    p.summary.push({ label: 'Sightings', value: String(sightings.length) });
    p.tables.push(table(`Pest sightings from ${ctx.since}`, [
      { label: 'Date', width: 0.9 }, { label: 'Pest', width: 1 }, { label: 'Evidence', width: 1 }, { label: 'Where', width: 1.6 },
      { label: 'Severity', width: 0.8 }, { label: 'Action taken', width: 2 }, { label: 'Closed', width: 0.9 },
    ], sightings.map((x) => row([
      s(x.business_date), s(x.pest_type), s(x.evidence_kind), s(x.location_label), s(x.severity), s(x.immediate_action),
      s(x.closed_at).slice(0, 10) || 'open',
    ], '/fssai/pest-control', s(x.closed_at) ? '' : 'bad')), ctx.limit, 'No pest sighting was reported in these dates.'));
  }
  if (ctx.present.has('fssai_pest_devices')) {
    const devices = ctx.db.prepare(
      `SELECT code, device_kind, location_label, check_frequency, last_checked_at
         FROM fssai_pest_devices WHERE is_active = 1 ORDER BY sort_order, code`,
    ).all() as any[];
    if (devices.length) {
      p.summary.push({ label: 'Stations', value: String(devices.length) });
      p.tables.push(table('Bait stations and traps', [
        { label: 'Code', width: 0.8 }, { label: 'Kind', width: 1.2 }, { label: 'Location', width: 2.2 },
        { label: 'Checked', width: 1 }, { label: 'Last checked', width: 1.2 },
      ], devices.map((d) => row([
        s(d.code), s(d.device_kind), s(d.location_label), s(d.check_frequency), s(d.last_checked_at).slice(0, 10) || '—',
      ], '/fssai/pest-control')), ctx.limit));
    }
  }
  if (p.status !== 'present' && !p.todo) {
    p.todo = 'Close each open sighting on Pest Control Logs with what was done about it.';
  }
  return p;
}

function fifo(ctx: Ctx): Part {
  const p = checklistRecord(ctx, 'fifo', `t.module_key = ?`, ['storage'], 'storage round',
    'Run the storage checklists on Food Storage Checks — the daily dry-store and cold-store rounds (oldest stock to the front, FEFO) and the weekly rotation round.',
    [{ href: '/fssai/storage', label: 'Food Storage Checks' }, { href: '/fssai/fifo', label: 'FIFO & Expiry Management' }],
    'No storage checklist is published. An administrator publishes the ready-made ones under FSSAI Settings.');
  p.basis = 'FIFO and FEFO are asked on the storage rounds (dry store, cold store, weekly rotation). ' + p.basis;
  if (ctx.present.has('fssai_expiry_items')) {
    const items = ctx.db.prepare(
      `SELECT business_date, material_name, batch_label, lot_no, location_label, expiry_date, state, action_taken, qty, uom
         FROM fssai_expiry_items e
        WHERE ${LIVE('e')} AND business_date >= ? AND business_date <= ?
        ORDER BY business_date DESC`,
    ).all(ctx.since, ctx.today) as any[];
    p.summary.push({ label: 'Expiry entries', value: String(items.length) });
    p.tables.push(table(`Expiry register from ${ctx.since}`, [
      { label: 'Found', width: 0.9 }, { label: 'Item', width: 2 }, { label: 'Lot', width: 0.9 }, { label: 'Where', width: 1.2 },
      { label: 'Expiry', width: 0.9 }, { label: 'State', width: 0.8 }, { label: 'Action', width: 1.2 },
    ], items.map((x) => row([
      s(x.business_date), s(x.material_name || x.batch_label), s(x.lot_no), s(x.location_label), s(x.expiry_date), s(x.state), s(x.action_taken),
    ], '/fssai/fifo', s(x.state) === 'expired' ? 'bad' : '')), ctx.limit, 'Nothing was entered in the expiry register in these dates.'));
  }
  return p;
}

/* 14 ─ Waste disposal record */
function waste(ctx: Ctx): Part {
  const p = blank();
  p.links = [DOCS_LINK, { href: '/fssai/fifo', label: 'FIFO & Expiry Management' }, { href: '/fssai/oil-quality', label: 'Oil Quality Checks' }];
  p.basis =
    `From Documents & Certificates ("Waste disposal record": the GHMC or authorised collector's agreement or receipts). One with an end date counts until then; ` +
    `one without counts for ${CURRENCY_DAYS.waste_record} days from its date. A copy must be attached. EXPIRING inside ${WARN_DAYS} days of the end. ` +
    'Expired stock discarded and used oil handed over are listed alongside it.';
  const todo =
    'File the waste collector\'s agreement or the latest collection receipts under Documents & Certificates as "Waste disposal record", with a scan.';
  const miss = absent(ctx.present, ['fssai_documents']);
  if (miss.length) { p.problems = [NOT_IN_DB(miss)]; p.todo = todo; return p; }

  const docs = readDocs(ctx, ['waste_disposal_record']);
  const usable = docs.filter((d) => d.stored > 0);
  const ends = usable.map((d) => ({ d, end: docCurrentUntil(d, CURRENCY_DAYS.waste_record) })).filter((x) => x.end).sort((a, b) => (a.end < b.end ? 1 : -1));
  const best = ends[0];
  const v = judgePeriod(best?.end || '', ctx.today, 'waste disposal record');
  p.status = v.status;
  p.problems = v.problems;
  if (!best && docs.length) p.problems = [`${docLabel(docs[0])} is recorded, but no copy of it is attached.`];
  p.lapses_on = best?.end || '';
  p.headline = best ? `${docLabel(best.d)}, good until ${best.end}` : docs.length ? `${plural(docs.length, 'record')} on file, none usable` : 'Nothing on file';
  p.summary = [{ label: 'On file', value: String(docs.length) }, { label: 'Good until', value: best?.end || '—' }];
  p.tables = [table('Waste disposal records', DOC_COLUMNS, docRows(docs), ctx.limit, 'Nothing of this kind is on file.')];
  p.scans = docs.flatMap((d) => d.scans);

  if (ctx.present.has('fssai_expiry_items')) {
    const discards = ctx.db.prepare(
      `SELECT business_date, material_name, batch_label, discard_qty, uom, discard_method, witnessed_by
         FROM fssai_expiry_items e
        WHERE ${LIVE('e')} AND action_taken = 'discarded' AND business_date >= ? AND business_date <= ?
        ORDER BY business_date DESC`,
    ).all(ctx.since, ctx.today) as any[];
    p.tables.push(table(`Expired or spoiled stock discarded from ${ctx.since}`, [
      { label: 'Date', width: 0.9 }, { label: 'Item', width: 2.2 }, { label: 'Quantity', width: 0.9, align: 'right' },
      { label: 'How', width: 1.4 }, { label: 'Witnessed by', width: 1.4 },
    ], discards.map((x) => row([
      s(x.business_date), s(x.material_name || x.batch_label), [numOrBlank(x.discard_qty, 2), s(x.uom)].filter(Boolean).join(' '),
      s(x.discard_method), s(x.witnessed_by),
    ], '/fssai/fifo')), ctx.limit, 'No stock was discarded in these dates.'));
  }
  if (ctx.present.has('fssai_oil_disposals')) {
    const oil = ctx.db.prepare(
      `SELECT business_date, collector_name, agency_reg_no, vehicle_no, quantity, uom, receipt_no
         FROM fssai_oil_disposals od
        WHERE ${LIVE('od')} AND business_date >= ? AND business_date <= ?
        ORDER BY business_date DESC`,
    ).all(ctx.since, ctx.today) as any[];
    p.tables.push(table(`Used oil handed over from ${ctx.since}`, [
      { label: 'Date', width: 0.9 }, { label: 'Collector', width: 1.8 }, { label: 'Registration', width: 1.2 }, { label: 'Vehicle', width: 1 },
      { label: 'Quantity', width: 0.9, align: 'right' }, { label: 'Receipt', width: 1 },
    ], oil.map((x) => row([
      s(x.business_date), s(x.collector_name), s(x.agency_reg_no), s(x.vehicle_no), [numOrBlank(x.quantity, 1), s(x.uom)].filter(Boolean).join(' '), s(x.receipt_no),
    ], '/fssai/oil-quality')), ctx.limit, 'No used oil was handed over in these dates.'));
  }
  if (p.status !== 'present') p.todo = todo;
  return p;
}

/* 15 ─ Used cooking-oil/TPC records */
function oil(ctx: Ctx): Part {
  const p = blank();
  p.links = [{ href: '/fssai/oil-quality', label: 'Oil Quality Checks' }];
  p.basis = logBasis(CADENCE.oil) + ' The authority asks for TPC: a period whose checks never measured TPC is MISSING. Used-oil handovers (RUCO) are listed with it.';
  const todo = 'Test the frying oil with a TPC tester and record each reading under Oil Quality Checks, with the oil changed when it reaches the limit.';
  const miss = absent(ctx.present, ['fssai_oil_checks']);
  if (miss.length) { p.problems = [NOT_IN_DB(miss)]; p.todo = todo; return p; }

  const latest = s((ctx.db.prepare(`SELECT MAX(business_date) AS d FROM fssai_oil_checks o WHERE ${LIVE('o')}`).get() as any)?.d);
  const rows = ctx.db.prepare(
    `SELECT id, business_date, checked_at, equipment_label, oil_type, method, tpm_pct, max_tpm_used, is_fail, is_judged,
            oil_changed, action_taken, recorded_name, recorded_by
       FROM fssai_oil_checks o
      WHERE ${LIVE('o')} AND business_date >= ? AND business_date <= ?
      ORDER BY business_date DESC, checked_at DESC`,
  ).all(ctx.since, ctx.today) as any[];
  const v = judgeLog(latest, ctx.today, CADENCE.oil, 'oil check');
  let status = v.status;
  const problems = [...v.problems];
  const measured = rows.filter((r) => r.tpm_pct !== null && r.tpm_pct !== undefined && r.tpm_pct !== '');
  if (rows.length && !measured.length) {
    status = 'missing';
    problems.push(`None of the ${plural(rows.length, 'oil check')} since ${ctx.since} measured TPC — they were visual only.`);
  }
  p.status = status;
  p.problems = problems;
  p.headline = latest ? `${plural(rows.length, 'check')} since ${ctx.since}, ${measured.length} with a TPC reading · last on ${latest}` : 'No oil check recorded';
  p.summary = [
    { label: 'Checks', value: String(rows.length) },
    { label: 'TPC measured', value: String(measured.length), mgmt: true },
    { label: 'Over the limit', value: String(rows.filter((r) => intOr(r.is_fail) === 1).length) },
    { label: 'Last check', value: latest || '—' },
  ];
  p.tables = [table(`Oil checks from ${ctx.since}`, [
    { label: 'Date', width: 0.9 }, { label: 'Fryer', width: 1.4 }, { label: 'Oil', width: 1 }, { label: 'Method', width: 0.9 },
    { label: 'TPC %', width: 0.6, align: 'right' }, { label: 'Limit %', width: 0.6, align: 'right' }, { label: 'Verdict', width: 0.8 },
    { label: 'Changed', width: 0.7 }, { label: 'By', width: 1.1 },
  ], rows.map((r) => row([
    s(r.business_date), s(r.equipment_label), s(r.oil_type), s(r.method), numOrBlank(r.tpm_pct, 1), numOrBlank(r.max_tpm_used, 0),
    intOr(r.is_judged, 1) === 0 ? 'Not judged' : intOr(r.is_fail) ? 'FAIL' : 'Within limit', intOr(r.oil_changed) ? 'Yes' : '',
    s(r.recorded_name || r.recorded_by),
  ], '/fssai/oil-quality', intOr(r.is_fail) ? 'bad' : '')), ctx.limit)];
  if (ctx.present.has('fssai_oil_disposals')) {
    const ruco = ctx.db.prepare(
      `SELECT id, business_date, collector_name, agency_reg_no, quantity, uom, receipt_no
         FROM fssai_oil_disposals od WHERE ${LIVE('od')} ORDER BY business_date DESC LIMIT 1`,
    ).get() as any;
    p.summary.push({ label: 'Last used-oil handover', value: ruco ? s(ruco.business_date) : '—' });
  }
  if (p.status !== 'present') p.todo = todo;
  return p;
}

/* 16 ─ Equipment maintenance records */
const MAINTENANCE_KINDS = ['repair', 'cleaning', 'defrost', 'breakdown', 'out_of_service', 'back_in_service', 'filter_change'];

function maintenance(ctx: Ctx): Part {
  const p = blank();
  p.links = [{ href: '/fssai/cold-rooms', label: 'Cold Room Climate Control' }, DOCS_LINK];
  p.basis =
    `PRESENT when a service, repair, defrost, deep clean or filter change was recorded in the last ${CURRENCY_DAYS.maintenance} days, or a service contract (AMC) is in force with a copy. ` +
    `MISSING when neither, or when a unit's own next-service date has passed. EXPIRING when a next-service date or the AMC falls within ${WARN_DAYS} days.`;
  const todo =
    'Record each service, repair and deep clean against the unit under Cold Room Climate Control (with the next due date), and file any AMC under Documents & Certificates.';
  const miss = absent(ctx.present, ['fssai_equipment_events', 'fssai_documents']);
  if (miss.length) { p.problems = [NOT_IN_DB(miss)]; p.todo = todo; return p; }

  const marks = MAINTENANCE_KINDS.map(() => '?').join(',');
  const events = ctx.db.prepare(
    `SELECT id, equipment_id, equipment_label, event_kind, business_date, detail, performed_by, reference_no, next_due_date
       FROM fssai_equipment_events ev
      WHERE ev.event_kind IN (${marks}) AND ev.voided_at = '' AND ev.status <> 'void'
      ORDER BY business_date DESC, created_at DESC`,
  ).all(...MAINTENANCE_KINDS) as any[];
  const amc = readDocs(ctx, ['amc']);
  const amcV = judgeDocs(amc, 'service contract (AMC)', ctx.today);

  const recentCut = addDaysISO(ctx.today, -CURRENCY_DAYS.maintenance);
  const recent = events.filter((e) => s(e.business_date) >= recentCut);
  const problems: string[] = [];
  let status: AuditFileStatus = recent.length || amcV.status !== 'missing' ? 'present' : 'missing';
  if (status === 'missing') {
    problems.push(events.length
      ? `No maintenance recorded in the last ${CURRENCY_DAYS.maintenance} days — the last was on ${s(events[0].business_date)}, and no service contract is in force.`
      : 'No maintenance has been recorded for any unit, and no service contract (AMC) is on file.');
  }
  if (amcV.status === 'expiring') { status = worst(status, 'expiring'); problems.push(...amcV.problems); }

  // Each unit's LATEST event sets its next-service date; an older one is history.
  const latestByUnit = new Map<string, any>();
  for (const e of events) {
    const k = s(e.equipment_id) || `label:${s(e.equipment_label)}`;
    if (!latestByUnit.has(k)) latestByUnit.set(k, e);
  }
  const lapses: string[] = [amcV.lapses_on];
  for (const e of latestByUnit.values()) {
    const due = s(e.next_due_date);
    if (!isISODate(due)) continue;
    lapses.push(due);
    const d = daysBetweenISO(ctx.today, due);
    if (d < 0) { status = 'missing'; problems.push(`${s(e.equipment_label) || 'A unit'}: next service was due on ${due} (${until(due, ctx.today)}) and is not recorded.`); }
    else if (d <= WARN_DAYS) { status = worst(status, 'expiring'); problems.push(`${s(e.equipment_label) || 'A unit'}: next service due on ${due} — ${until(due, ctx.today)}.`); }
  }

  p.status = status;
  p.problems = problems;
  p.lapses_on = earliest(lapses);
  p.headline = events.length
    ? `${plural(recent.length, 'maintenance entry', 'maintenance entries')} in the last ${CURRENCY_DAYS.maintenance} days · last on ${s(events[0].business_date)}`
    : amcV.best ? `AMC ${docLabel(amcV.best)}` : 'Nothing recorded';
  p.summary = [
    { label: 'Entries (92 days)', value: String(recent.length) },
    { label: 'Units', value: String(latestByUnit.size) },
    { label: 'AMC', value: amcV.best ? (amcV.best.expiry_date || 'no expiry') : '—' },
  ];
  const from = periodicFrom(ctx);
  const inWindow = events.filter((e) => s(e.business_date) >= from);
  p.tables = [
    table(`Maintenance from ${from}`, [
      { label: 'Date', width: 0.9 }, { label: 'Unit', width: 1.5 }, { label: 'What', width: 1.1 }, { label: 'Detail', width: 2.2 },
      { label: 'Done by', width: 1.2 }, { label: 'Ref.', width: 0.8 }, { label: 'Next due', width: 0.9 },
    ], inWindow.map((e) => row([
      s(e.business_date), s(e.equipment_label), s(e.event_kind).replace(/_/g, ' '), s(e.detail), s(e.performed_by), s(e.reference_no), s(e.next_due_date),
    ], '/fssai/cold-rooms', s(e.event_kind) === 'breakdown' ? 'bad' : '')), ctx.limit),
    table('Service contracts (AMC)', DOC_COLUMNS, docRows(amc), ctx.limit, 'No service contract is on file.'),
  ];
  p.scans = [
    ...amc.flatMap((d) => d.scans),
    ...readScans(ctx.db, 'fssai_equipment_events', inWindow.slice(0, 6).map((e) => s(e.id)),
      (id) => { const e = events.find((x) => s(x.id) === id); return e ? `${s(e.equipment_label)} — ${s(e.event_kind).replace(/_/g, ' ')} (${s(e.business_date)})` : 'Maintenance'; }),
  ];
  if (p.status !== 'present') p.todo = todo;
  return p;
}

/* 17 ─ Calibration certificates */
function calibration(ctx: Ctx): Part {
  const p = blank();
  p.links = [DOCS_LINK, { href: '/fssai/cold-rooms', label: 'Cold Room Climate Control' }];
  p.basis =
    "From Documents & Certificates (\"Calibration certificate\", filed against the instrument). Each instrument's latest certificate is judged on its own; " +
    'in force with a copy → PRESENT, inside its renewal window → EXPIRING, expired or no copy → MISSING. In-house probe checks are listed alongside.';
  const todo =
    'Have the thermometers and probes calibrated by an accredited lab and file each certificate under Documents & Certificates as "Calibration certificate", with a scan.';
  const miss = absent(ctx.present, ['fssai_documents']);
  if (miss.length) { p.problems = [NOT_IN_DB(miss)]; p.todo = todo; return p; }

  const docs = readDocs(ctx, ['calibration_certificate']);
  const groups = new Map<string, DocRow[]>();
  for (const d of docs) {
    const k = d.equipment_id || `doc:${d.id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(d);
  }
  // An instrument not in the equipment register is named by its certificate.
  const who = (d: DocRow) => d.equipment_name || d.title || d.type_label;
  let status: AuditFileStatus = groups.size ? 'present' : 'missing';
  const problems: string[] = groups.size ? [] : ['No calibration certificate is on file.'];
  const lapses: string[] = [];
  for (const list of groups.values()) {
    const v = judgeDocs(list, 'calibration certificate', ctx.today);
    status = worst(status, v.status);
    if (v.status !== 'present') problems.push(`${who(list[0])}: ${v.problems[0] || ''}`);
    if (v.lapses_on) lapses.push(v.lapses_on);
  }
  p.status = status;
  p.problems = problems;
  p.lapses_on = earliest(lapses);
  p.headline = groups.size ? `${plural(groups.size, 'instrument')} with a certificate on file` : 'Nothing on file';
  p.summary = [{ label: 'Instruments', value: String(groups.size) }, { label: 'Next to lapse', value: p.lapses_on || '—' }];
  p.tables = [table('Certificates on file', [{ label: 'Instrument — certificate', width: 2.6 }, ...DOC_COLUMNS.slice(1)], docRows(docs, who), ctx.limit,
    'Nothing of this kind is on file.')];
  p.scans = docs.flatMap((d) => d.scans);

  const inHouse: AuditFileRow[] = [];
  if (ctx.present.has('fssai_equipment_events')) {
    const ev = ctx.db.prepare(
      `SELECT business_date, equipment_label, value_before, reference_value, value_after, deviation, uom, is_fail, performed_by
         FROM fssai_equipment_events ev
        WHERE ev.event_kind = 'calibration' AND ev.voided_at = '' AND ev.status <> 'void' AND business_date >= ? AND business_date <= ?
        ORDER BY business_date DESC`,
    ).all(ctx.since, ctx.today) as any[];
    for (const e of ev) {
      inHouse.push(row([
        s(e.business_date), s(e.equipment_label), numOrBlank(e.value_before, 1), numOrBlank(e.reference_value, 1), numOrBlank(e.value_after, 1),
        numOrBlank(e.deviation, 1), intOr(e.is_fail) ? 'FAIL' : 'Pass', s(e.performed_by),
      ], '/fssai/cold-rooms', intOr(e.is_fail) ? 'bad' : ''));
    }
  }
  if (inHouse.length) {
    p.tables.push(table(`In-house calibration checks from ${ctx.since}`, [
      { label: 'Date', width: 0.9 }, { label: 'Instrument', width: 1.8 }, { label: 'Before', width: 0.7, align: 'right' },
      { label: 'Reference', width: 0.8, align: 'right' }, { label: 'After', width: 0.7, align: 'right' }, { label: 'Deviation', width: 0.8, align: 'right' },
      { label: 'Result', width: 0.7 }, { label: 'By', width: 1.2 },
    ], inHouse, ctx.limit));
  }
  if (p.status !== 'present') p.todo = todo;
  return p;
}

/* 19 ─ Food sampling/lab reports, where applicable */
function foodLab(ctx: Ctx): Part {
  const p = blank();
  p.links = [DOCS_LINK];
  p.basis =
    `From Documents & Certificates ("Food sampling/lab report"). One counts until its own end date, or for ${CURRENCY_DAYS.food_lab} days from its date; a copy must be attached. ` +
    'The authority asks for these only where applicable — if your licence category does not require food sampling, say so to the inspector; this page cannot tell.';
  const todo =
    'If food sampling applies to this outlet, file the latest laboratory report under Documents & Certificates as "Food sampling/lab report", with a scan.';
  const miss = absent(ctx.present, ['fssai_documents']);
  if (miss.length) { p.problems = [NOT_IN_DB(miss)]; p.todo = todo; return p; }
  const docs = readDocs(ctx, ['food_lab_report']);
  const ends = docs.filter((d) => d.stored > 0).map((d) => ({ d, end: docCurrentUntil(d, CURRENCY_DAYS.food_lab) }))
    .filter((x) => x.end).sort((a, b) => (a.end < b.end ? 1 : -1));
  const best = ends[0];
  const v = judgePeriod(best?.end || '', ctx.today, 'food lab report');
  p.status = v.status;
  p.problems = v.problems.map((x) => (x.startsWith('No ') ? `${x} (Needed only where applicable.)` : x));
  if (!best && docs.length) p.problems = [`${docLabel(docs[0])} is recorded, but no copy of it is attached.`];
  p.lapses_on = best?.end || '';
  p.headline = best ? `${docLabel(best.d)}, good until ${best.end}` : docs.length ? `${plural(docs.length, 'report')} on file, none usable` : 'Nothing on file';
  p.summary = [{ label: 'On file', value: String(docs.length) }, { label: 'Good until', value: best?.end || '—' }];
  p.tables = [table('Food lab reports', DOC_COLUMNS, docRows(docs), ctx.limit, 'Nothing of this kind is on file.')];
  p.scans = docs.flatMap((d) => d.scans);
  if (p.status !== 'present') p.todo = todo;
  return p;
}

/* 20 ─ Previous audit report and closure evidence */
function previousAudit(ctx: Ctx): Part {
  const p = blank();
  p.links = [{ href: '/fssai/inspections', label: 'Inspection Reports' }, { href: '/fssai/corrective-actions', label: 'Corrective Actions' }, DOCS_LINK];
  p.basis =
    'The last visit recorded under Inspection Reports, its report (a copy filed under Documents & Certificates as "Previous audit report and closure evidence", or attached to the visit), ' +
    'and every point it raised. PRESENT when the report copy is on file and every point is closed; EXPIRING while points are open but not yet due; MISSING without a copy, or when an open point is past its due date.';
  const todo =
    'Record the last visit under Inspection Reports with each point it raised, close each point with what was done, and file the authority\'s report under Documents & Certificates with a scan.';
  const miss = absent(ctx.present, ['fssai_inspections', 'fssai_inspection_findings', 'fssai_documents']);
  if (miss.length) { p.problems = [NOT_IN_DB(miss)]; p.todo = todo; return p; }

  const visits = ctx.db.prepare(
    `SELECT id, inspection_no, inspection_kind, authority, inspector_name, business_date, score, score_max, grade, outcome,
            report_no, document_id, finding_count, open_count, status
       FROM fssai_inspections i
      WHERE i.voided_at = '' AND i.status NOT IN ('void','planned') AND i.business_date <= ?
      ORDER BY business_date DESC, created_at DESC`,
  ).all(ctx.today) as any[];
  const reportDocs = readDocs(ctx, ['audit_report']);
  const last = visits[0];

  // The report copy: an audit-report document, the document the visit points
  // at, or a file attached to the visit itself.
  let copies = reportDocs.filter((d) => d.stored > 0).length;
  const scans: AuditFileScan[] = reportDocs.flatMap((d) => d.scans);
  if (last && s(last.document_id)) {
    const linked = scans.some((sc) => sc.entity_id === s(last.document_id)) ? [] :
      readScans(ctx.db, 'fssai_documents', [s(last.document_id)], () => `Report of the visit on ${s(last.business_date)}`);
    copies += linked.filter((sc) => sc.has_image).length;
    scans.push(...linked);
  }
  if (last) {
    const own = readScans(ctx.db, 'fssai_inspections', [s(last.id)], () => `Visit on ${s(last.business_date)}`);
    copies += own.filter((sc) => sc.has_image).length;
    scans.push(...own);
  }

  const findings = last ? ctx.db.prepare(
    `SELECT f.finding_no, f.clause_ref, f.severity, f.observation, f.due_date, f.status, f.response, f.closed_at,
            ca.ca_number, ca.status AS ca_status, ca.action_taken, ca.verified_by
       FROM fssai_inspection_findings f
       LEFT JOIN fssai_corrective_actions ca ON ca.id = f.ca_id
      WHERE f.inspection_id = ?
      ORDER BY f.sort_order, f.finding_no`,
  ).all(s(last.id)) as any[] : [];
  const isOpen = (f: any) => ['open', 'in_progress'].includes(s(f.status));
  const open = findings.filter(isOpen);
  const overdue = open.filter((f) => isISODate(s(f.due_date)) && s(f.due_date) < ctx.today);

  const problems: string[] = [];
  let status: AuditFileStatus = 'present';
  if (!last && !reportDocs.length) {
    status = 'missing';
    problems.push('No previous inspection or audit is recorded, and no audit report is filed. (If this outlet has never been audited, there is none to keep.)');
  } else if (!copies) {
    status = 'missing';
    problems.push(last
      ? `The visit on ${s(last.business_date)}${s(last.authority) ? ` by ${s(last.authority)}` : ''} is recorded, but no copy of its report is on file.`
      : 'An audit report is recorded, but no copy of it is attached.');
  }
  if (overdue.length) {
    status = 'missing';
    problems.push(`${plural(overdue.length, 'point')} from the visit on ${s(last.business_date)} ${overdue.length === 1 ? 'is' : 'are'} past the due date and not closed.`);
  } else if (open.length) {
    status = worst(status, 'expiring');
    const due = earliest(open.map((f) => s(f.due_date)));
    problems.push(`${plural(open.length, 'point')} from the visit on ${s(last.business_date)} still open${due ? `, the first due on ${due}` : ''}.`);
    p.lapses_on = due;
  }

  p.status = status;
  p.problems = problems;
  p.headline = last
    ? `Last visit ${s(last.business_date)}${s(last.authority) ? ` — ${s(last.authority)}` : ''} · ${plural(findings.length, 'point')}, ${open.length} open · ${plural(copies, 'report copy', 'report copies')}`
    : reportDocs.length ? `${plural(reportDocs.length, 'audit report')} on file` : 'Nothing recorded';
  p.summary = [
    { label: 'Visits recorded', value: String(visits.length) },
    { label: 'Last visit', value: last ? s(last.business_date) : '—' },
    { label: 'Points raised', value: String(findings.length) },
    { label: 'Still open', value: String(open.length) },
  ];
  p.tables = [
    table('Visits', [
      { label: 'Date', width: 0.9 }, { label: 'Authority', width: 1.6 }, { label: 'Inspector', width: 1.3 }, { label: 'Report no.', width: 1 },
      { label: 'Score', width: 0.7, align: 'right' }, { label: 'Grade', width: 0.6 }, { label: 'Points', width: 0.6, align: 'right' }, { label: 'Open', width: 0.6, align: 'right' },
    ], visits.map((v) => row([
      s(v.business_date), s(v.authority) || s(v.inspection_kind).replace(/_/g, ' '), s(v.inspector_name), s(v.report_no) || s(v.inspection_no),
      v.score === null || v.score === undefined ? '' : `${v.score}${v.score_max ? ` / ${v.score_max}` : ''}`, s(v.grade), intOr(v.finding_count), intOr(v.open_count),
    ], '/fssai/inspections', intOr(v.open_count) > 0 ? 'warn' : '')), ctx.limit, 'No visit is recorded.'),
    table(last ? `Points raised on ${s(last.business_date)} and how each was closed` : 'Points raised', [
      { label: 'No.', width: 0.5 }, { label: 'Clause', width: 0.8 }, { label: 'Observation', width: 2.4 }, { label: 'Due', width: 0.9 },
      { label: 'Status', width: 0.8 }, { label: 'What was done', width: 2.2 }, { label: 'Checked by', width: 1.1 },
    ], findings.map((f) => row([
      s(f.finding_no), s(f.clause_ref), s(f.observation), s(f.due_date), s(f.status).replace(/_/g, ' '),
      s(f.action_taken) || s(f.response), s(f.verified_by),
    ], '/fssai/inspections', overdue.includes(f) ? 'bad' : isOpen(f) ? 'warn' : '')), ctx.limit, 'The visit raised no points.'),
    table('Audit reports on file', DOC_COLUMNS, docRows(reportDocs), ctx.limit, 'No audit report document is on file.'),
  ];
  p.scans = scans;
  if (p.status !== 'present') p.todo = todo;
  return p;
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE FILE
 * ══════════════════════════════════════════════════════════════════════════ */

const BUILDERS: Record<AuditFileKey, (ctx: Ctx) => Part> = {
  fssai_licence: fssaiLicence,
  fsdb_photo: fsdbPhoto,
  ghmc_licence: ghmcLicence,
  water,
  pest_control: pestControl,
  medical: (ctx) => perPerson(ctx, 'medical_fitness', 'medical fitness certificate',
    'File a medical fitness certificate for every food handler under Documents & Certificates as "Medical fitness certificate", against the person, with a scan.'),
  training: (ctx) => perPerson(ctx, 'food_handler_training', 'food-safety training certificate',
    'File each food handler\'s food-safety training (FoSTaC or in-house) under Documents & Certificates as "Food handler training", against the person, with a scan.'),
  vendors,
  receiving,
  cold_temps: (ctx) => tempLog(ctx, 'cold_temps', ['equipment'], 'refrigerator or freezer reading',
    'Read every refrigerator, freezer and cold room on its round and record it under Temperature Logs (or on the cold-store checklist).',
    [{ href: '/fssai/temperature', label: 'Temperature Logs' }, { href: '/fssai/cold-rooms', label: 'Cold Room Climate Control' }]),
  cooking_temps: (ctx) => tempLog(ctx, 'cooking_temps', ['cooking', 'reheating', 'cooling', 'hot_holding'], 'cooking or reheating temperature',
    'Probe cooked, reheated, hot-held and cooling food and record each reading under Temperature Logs.',
    [{ href: '/fssai/temperature', label: 'Temperature Logs' }]),
  cleaning,
  pest_monitoring: pestMonitoring,
  waste,
  oil,
  maintenance,
  calibration,
  fifo,
  food_lab: foodLab,
  previous_audit: previousAudit,
};

/**
 * Work out all 20 records. Read-only; never throws for one record — a record
 * whose read fails is MISSING with the reason, and the other 19 still render.
 */
export function buildAuditFile(db: Database.Database, today: string, opts: AuditFileOptions = {}): AuditFile {
  const days = AUDIT_FILE_DAY_CHOICES.includes(Number(opts.days) as any) ? Number(opts.days) : AUDIT_FILE_DEFAULT_DAYS;
  const ctx: Ctx = {
    db,
    today,
    days,
    since: addDaysISO(today, -(days - 1)),
    limit: Math.max(1, Math.min(Number(opts.rowLimit) || 8, 2000)),
    present: fssaiTablesPresent(db),
  };

  const items: AuditFileItem[] = AUDIT_FILE_RECORDS.map((rec) => {
    let part: Part;
    try {
      part = BUILDERS[rec.key](ctx);
    } catch (e: any) {
      console.error(`[fssai/audit-file] ${rec.key} failed:`, e?.message || e);
      part = {
        ...blank(),
        problems: [`This record could not be read (${String(e?.message || e)}). Treat it as missing until it can.`],
        todo: 'Open the record\'s own screen to check it, and report the error.',
      };
    }
    // HELD — one rule for all 20, from what the record will actually print:
    // a line the handover may carry, or a copy still stored.
    part.held = part.tables.some((t) => t.handover_rows > 0) || part.scans.some((sc) => sc.has_image);
    return { n: rec.n, key: rec.key, title: rec.title, ...part };
  });

  const counts = { present: 0, expiring: 0, missing: 0, total: items.length };
  for (const it of items) counts[it.status]++;
  return { section: AUDIT_FILE_SECTION, today, days, since: ctx.since, counts, items };
}

export const AUDIT_FILE_STATUS_WORDS: Record<AuditFileStatus, string> = {
  present: 'PRESENT',
  expiring: 'EXPIRING',
  missing: 'MISSING',
};
