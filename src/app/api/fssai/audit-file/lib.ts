/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';
import {
  addDaysISO, daysBetweenISO, fssaiDocState, fssaiDocType, fssaiTempLogKindLabel, isISODate,
  FSSAI_DOC_REMINDER_DAYS, type FssaiDocState,
} from '@/lib/fssai';
import {
  FSSAI_HANDLER_REQUIREMENTS, fssaiDocCountsSql, fssaiDocumentHolders, fssaiNotYetWords, fssaiPaperStartsOn,
  fssaiSupersededStillInForce, readFssaiFoodHandlerCoverage,
  type FssaiFoodHandlerWithCoverage, type FssaiHandlerCoverage, type FssaiHandlerRequirementKey,
} from '@/lib/fssai-food-handlers';
import {
  FSSAI_HYD_AUDIT_CODES, FSSAI_HYD_WORKBOOK, fssaiHydAnswerSheet, fssaiHydAuditTemplateSql,
  type HydAnswer, type HydAnswerSheetRow,
} from '@/lib/fssai-checklist-pack';
import { fssaiTablesPresent, intOr, numOrBlank } from '../_p9/lib';
import { fssaiReadingScheduleValue, fssaiTempMinutesWords, fssaiTempVerdictWord } from '../_p4/lib';
import { readPestChemicalsApplied, readPestMonitoringSheet } from '../pest/_pest/monitoring';
import { wasteHandoverAuditPart } from '../_waste/lib';
import { readFssaiVisitClosureEvidence, type FssaiClosureFile, type FssaiVisitClosureEvidence } from '../_closure/lib';
import { vendorRegisterReady } from '../../vendors/fssai-register';

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
 * document counts only when a LIVE image of it is stored: a fssai_attachments
 * row with data_uri <> '' AND status <> 'void'.
 *   · Owner ruling Q22 (2026-10-14, FSSAI_Q22_RULING in fssai-retention.ts):
 *     document scans in fssai_attachments are NEVER auto-deleted — the photo
 *     sweep walks checklist photos (fssai_evidence) only. A blank data_uri can
 *     therefore only be a row an earlier build stripped (image_dropped_at); it
 *     still reads MISSING here, with the date, so somebody re-attaches it.
 *   · A VOIDED file (attached by mistake — kept, with who, when and why) is
 *     never a copy. It is listed apart (`voided_scans`) on the page and in the
 *     management copy, and never drawn into either PDF (scans.ts is the second
 *     gate). buildAuditFile() makes that split once, for every record, so no
 *     single record can forget it.
 *   · The rule holds for third-party papers that live outside Documents too:
 *     a lab report typed in under Water & Ice (4) counts only with a live copy
 *     of the laboratory's report on it; the last pest visit (5) only with a
 *     live copy of the technician's job sheet; an approved supplier (8) only
 *     with a licence in force WITH its copy (judgeDocs, like records 1–3).
 *
 * ── THE INSPECTOR'S COPY HOLDS WHAT IS IN FORCE, AND NOTHING BESIDE A GAP ──
 * The handover PDF's cover says "Documents and certificates: those in force".
 * So a paper the record itself does not judge in order — its row and its scan
 * (AuditFileScan.in_handover) — stays on the page and the management copy,
 * with the reason in its State cell, and never goes into the handover. ONE
 * rule decides it, fssaiHandoverPaperJudge(), and Inspection Mode's documents
 * section asks the same function, so the two copies an inspector is given
 * cannot disagree (2026-10-15). A paper is in order when
 *   · it has not EXPIRED;
 *   · it has STARTED — a paper is in force only from its valid_from date
 *     (owner ruling 2026-10-15): a renewal filed early reads "Not yet in
 *     force (from <date>)", is never the paper a record or a person rests
 *     on, and the record is judged on what is in force today;
 *   · it has not lapsed BY PERIOD — a paper with no expiry date of its own
 *     stands for FSSAI_DOC_PERIOD_DAYS from its date (a water bill the quarter
 *     it was issued in, a food lab report a year); a laboratory water report
 *     until its next-test date;
 *   · a person's certificate is in order under the food-handler record
 *     (fssaiPersonPapersInOrder): a medical or FoSTaC certificate with no
 *     expiry date is NOT, and a certificate that matches nobody working here
 *     as a food handler is not counted at all;
 *   · and a LIVE copy of it is stored.
 * An EXPIRED or lapsed line is a sentence about a lapse, and on a person's
 * certificate it names someone not in order (§7 Q11). And a register listed BESIDE a record
 * never carries that record into the handover alone (keepOutOfHandover):
 * cooling readings (11), the daily pest look (13), the agreement / discards /
 * used oil (14), breakdowns (16), in-house probe checks (17), the expiry
 * register (18), and another visit's audit report (20).
 *
 * ── READ-ONLY ───────────────────────────────────────────────────────────────
 * There is no INSERT, UPDATE or DELETE in this file. Voided records (§19: void,
 * never delete) are excluded from what counts, and drafts are not filed
 * records, so neither can make a record PRESENT.
 *
 * ── WHAT OTHER LANES' REGISTERS DECIDE HERE (2026-10-14) ────────────────────
 *   6, 7  readFssaiFoodHandlerCoverage — the food-handler register, which NAMES
 *         every handler without a valid certificate, and the FoSTaC line.
 *   11    cooking and reheating readings only — a cooling or hot-holding reading
 *         is listed, never what makes the log PRESENT.
 *   13    readPestMonitoringSheet — the station-by-station check, never a
 *         checklist round (the monthly Hyderabad Checklist 3 has a Pests
 *         section and is NOT the monitoring sheet: fssaiHydAuditTemplateSql).
 *   14    wasteHandoverAuditPart — the handover log; the agreement beside it.
 *   20    readFssaiVisitClosureEvidence — live report copies and closure photos.
 *   5     readPestChemicalsApplied — what each visit applied, printed with it.
 * And beyond the 20: the authority's own three checklist pages, the last
 * self-audit of each laid back onto the page as YES / NO / REMARK
 * (fssaiHydAnswerSheet) — an inspector can read the passing answers.
 * Every temperature verdict word and minutes cell comes from _p4/lib
 * (fssaiTempVerdictWord, fssaiTempMinutesWords), the same words the Reports
 * screen prints, so the PDF cannot call a pot still cooling "In range".
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

/**
 * The period a paper with NO expiry date of its own stands for, by document
 * type (from CURRENCY_DAYS). Such a paper lapses BY PERIOD: on its expiry date
 * when it has one, else this many days from its own date (valid from, issued
 * on, or the day it was filed). Every record here and Inspection Mode judge it
 * by the same end — fssaiPaperUntil().
 */
export const FSSAI_DOC_PERIOD_DAYS: Readonly<Record<string, number>> = {
  water_test: CURRENCY_DAYS.water_test,
  water_bill: CURRENCY_DAYS.water_bill,
  waste_disposal_record: CURRENCY_DAYS.waste_record,
  food_lab_report: CURRENCY_DAYS.food_lab,
};

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
  /**
   * 'bad' = a failed/expired line, 'warn' = expiring, 'void' = a line voided
   * and KEPT (printed greyed and struck through, with its reason in a cell).
   * Colours only — nothing is judged from it.
   */
  tone: '' | 'bad' | 'warn' | 'void';
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
  /** false only on a row an earlier build stripped (image_dropped_at). */
  has_image: boolean;
  image_dropped_at: string;
  /**
   * 'void' = attached by mistake and voided — KEPT, with who, when and why. A
   * void file is never a copy: buildAuditFile moves it to `voided_scans`.
   */
  status: 'active' | 'void';
  voided_at: string;
  voided_by: string;
  void_reason: string;
  /**
   * false = a LIVE copy the inspector's copy (the handover PDF) must not carry:
   * the scan of a document that has EXPIRED (the cover says "those in force"),
   * or a file that only travels beside a record the copy does not hold. The
   * page and the management copy show it either way. Never decides a status.
   */
  in_handover: boolean;
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
  /** LIVE copies only — what counts, what the PDF draws. */
  scans: AuditFileScan[];
  /**
   * Files on these records that were VOIDED — kept and shown (the page, the
   * management copy) with the reason, never counted, never in the handover.
   */
  voided_scans: AuditFileScan[];
}

/* ── the authority's own checklist pages, answered ───────────────────────── */

export interface AuditFileSelfAuditRow {
  /** 'heading' | 'lead_in' | 'subheading' | 'line' (the workbook row's kind). */
  kind: string;
  /** The authority's words, exactly as on its page. */
  text: string;
  /** On a line: 'YES' | 'NO' | 'N/A' | '' (not answered). */
  mark: string;
  remark: string;
  /** The question code the line is asked as (Q01…), '' on a heading. */
  question_code: string;
}

export interface AuditFileSelfAudit {
  /** The tab name on the authority's workbook ("CHECKLIST 1"). */
  sheet: string;
  /** The pack code the page was seeded as (CHK-HYD-AUDIT-k). */
  template_code: string;
  /** The checklist's name as the outlet now calls it. */
  template_name: string;
  /** The latest submitted or verified round of it, or null when none. */
  run: null | {
    id: string;
    business_date: string;
    status: string;
    outcome: string;
    recorded_by: string;
    signed_by: string;
    href: string;
  };
  rows: AuditFileSelfAuditRow[];
  counts: { lines: number; yes: number; no: number; na: number; unanswered: number };
  /** Answers to questions the owner added in the builder (not lines of the page). */
  extra: Array<{ question_code: string; prompt: string; mark: string; remark: string }>;
  /** Rounds of this page submitted in the audit file's window. */
  rounds_in_window: number;
  /** Management words: why there is no sheet. '' when there is one. */
  problem: string;
  /**
   * Management words: answers whose stored question no longer reads as the
   * authority's line with its code (a code edited in the builder, or a page
   * seeded by an older pack). Each is laid on the line its WORDS match, or —
   * when they match none — listed with its own words, never on a line it
   * was not asked as. [] when every answer sits on its own line.
   */
  drift: string[];
}

export interface AuditFile {
  section: string;
  today: string;
  days: number;
  since: string;
  counts: { present: number; expiring: number; missing: number; total: number };
  items: AuditFileItem[];
  /**
   * What the inspector's copy (the handover PDF) holds — worked out once, here,
   * so the page, Inspection Mode and the PDF all state the same N of 20.
   */
  handover: { held: number[]; left_out: number[]; count: number; total: number };
  /** The authority's three checklist pages, each with its last self-audit. */
  self_audit: AuditFileSelfAudit[];
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
/**
 * A "Next due" cell: the date the next visit or service is due, only while it
 * is still to come. A next-due date already past says the visit is overdue —
 * a sentence about a gap (§7 Q11) — so the row (which the inspector's copy
 * may carry) leaves it blank; the record's problems and its management-only
 * "Next due" box say it. Inspection Mode's water and pest rows do the same.
 */
function dueCell(v: unknown, today: string): string {
  const d = s(v);
  return isISODate(d) && d < today ? '' : d;
}

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

/**
 * A person, as the inspector's copy may name them: the user's NAME for a login
 * (the copy goes to an outside authority, and a login email is not something
 * to hand over), "a manager" for a login with no name on its user row, and any
 * other value (a name typed in) as it is.
 */
function personWords(db: Database.Database, v: unknown): string {
  const x = s(v).trim();
  if (!x || !x.includes('@')) return x;
  try {
    const u = db.prepare(`SELECT name FROM users WHERE lower(email) = lower(?) LIMIT 1`).get(x) as any;
    return s(u?.name).trim() || 'a manager';
  } catch {
    return 'a manager';
  }
}

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
  /** fssai_documents.handler_id — the food handler the certificate belongs to. */
  handler_id: string;
  /** Whose certificate, in words ("Ravi Kumar (FH-0001)"), from fssaiDocumentHolders. */
  holder: string;
  equipment_id: string;
  equipment_name: string;
  created_on: string;
  reminder_days: unknown;
  /** LIVE images still stored. A row with 0 has no copy anyone can read. */
  stored: number;
  /** Files on it that were voided — kept, never a copy. */
  voided: number;
  /** When the most recent image on it was removed, '' if none was. */
  dropped_at: string;
  scans: AuditFileScan[];
  /**
   * The record judges this paper IN ORDER today (fssaiHandoverPaperJudge): not
   * expired, not lapsed by its period, a person's certificate in order under
   * the food-handler record, and a live copy stored. Only such a paper — its
   * row and its scans — goes into the inspector's copy.
   */
  in_order: boolean;
  /** The day it stops standing: its expiry, or its period's end ('' = does not lapse). */
  until: string;
  /**
   * Its valid_from when that is after today: on file but NOT in force yet (a
   * renewal filed early, owner ruling 2026-10-15) — never the paper a record
   * rests on today. '' when it has started (or has expired).
   */
  starts_on: string;
  /** The State cell, in words ("Valid", "EXPIRED", "Lapsed 2026-09-17", "No expiry date", "Not yet in force (from 2026-10-22)"). */
  state_words: string;
  /** Management words: why it is not in order ('' when it is). */
  why_not: string;
}

/* ── IN ORDER ON THE DAY — one rule for the audit file AND Inspection Mode ── */

/** The dates of a paper that decide whether it still stands. */
export interface FssaiPaperDates {
  doc_type: string;
  expiry_date: string;
  valid_from: string;
  issued_on: string;
  /** The day it was filed (YYYY-MM-DD) — the last fallback for a period paper. */
  created_on: string;
}

/**
 * The day a paper stops standing: its own expiry date; else, for a paper that
 * stands for a period (FSSAI_DOC_PERIOD_DAYS), that period from its date; else
 * '' — a paper that does not lapse (a licence with no expiry date recorded, a
 * photograph of the display board).
 */
export function fssaiPaperUntil(d: FssaiPaperDates): string {
  if (isISODate(d.expiry_date)) return d.expiry_date;
  const days = FSSAI_DOC_PERIOD_DAYS[d.doc_type];
  if (!days) return '';
  const from = [d.valid_from, d.issued_on, d.created_on].find((x) => isISODate(x)) || '';
  return from ? addDaysISO(from, days) : '';
}

export interface FssaiPaperForce {
  in_force: boolean;
  until: string;
  state_words: string;
  /** Management words: why it is not in force ('' when it is). */
  why: string;
}

/**
 * IN FORCE BY ITS DATE — not EXPIRED, and not lapsed BY PERIOD: a water bill
 * older than its quarter, a food lab report with no validity date older than a
 * year, are as out of date as an expired licence, though neither carries an
 * expiry date to say so.
 * Whether it has STARTED (its valid_from, owner ruling 2026-10-15) is the one
 * judge's own test (fssaiHandoverPaperJudge → fssaiPaperNotYetInForce), kept
 * apart because the Documents register report (_p9/reports.ts) counts every
 * paper this calls not in force as Expired — a renewal filed early is not that.
 */
export function fssaiPaperInForce(d: FssaiPaperDates, state: FssaiDocState, today: string): FssaiPaperForce {
  const end = fssaiPaperUntil(d);
  if (state === 'expired') {
    return { in_force: false, until: end, state_words: STATE_WORDS.expired, why: `it expired on ${d.expiry_date}` };
  }
  const period = FSSAI_DOC_PERIOD_DAYS[d.doc_type];
  if (period && !isISODate(d.expiry_date)) {
    if (!end) {
      return { in_force: false, until: '', state_words: 'Undated', why: 'it carries no date, so nobody can say which period it stands for' };
    }
    if (end < today) {
      return {
        in_force: false, until: end, state_words: `Lapsed ${end}`,
        why: `it stands for ${plural(period, 'day')} from its date, which ran out on ${end} — ${until(end, today)}`,
      };
    }
    return { in_force: true, until: end, state_words: `Until ${end}`, why: '' };
  }
  return { in_force: true, until: end, state_words: STATE_WORDS[state], why: '' };
}

/** Management words for a paper in force only from a day still to come. */
function notYetWhy(startsOn: string, today: string): string {
  return `it is in force only from ${startsOn} — ${until(startsOn, today)}; a paper filed ahead of its valid-from date (a renewal filed early) does not stand until then`;
}

/**
 * NOT YET IN FORCE (owner ruling 2026-10-15): a paper is in force only from its
 * valid_from date. A renewal filed early is not in force until then, so it is
 * never handed over as the paper the outlet (or the person) holds today, and
 * the record is judged on what IS in force today. '' starts_on = it has started.
 */
export function fssaiPaperNotYetInForce(d: { valid_from: string }, today: string): { starts_on: string; state_words: string; why: string } {
  const starts = fssaiPaperStartsOn(d.valid_from, today);
  return starts
    ? { starts_on: starts, state_words: fssaiNotYetWords(starts), why: notYetWhy(starts, today) }
    : { starts_on: '', state_words: '', why: '' };
}

/**
 * The day a laboratory water report (fssai_water_tests, test_kind
 * 'lab_report') stops standing: the next-test date written on it, else
 * CURRENCY_DAYS.water_test from the report (or the sample, or the day it was
 * entered). Record 4 and Inspection Mode's water section both judge by it.
 */
export function fssaiWaterLabUntil(r: { next_due_date?: unknown; report_date?: unknown; sample_date?: unknown; business_date?: unknown }): { from: string; until: string } {
  const from = [s(r.report_date), s(r.sample_date), s(r.business_date)].find((x) => isISODate(x)) || '';
  const next = s(r.next_due_date);
  return { from, until: isISODate(next) ? next : from ? addDaysISO(from, CURRENCY_DAYS.water_test) : '' };
}

/** One person's paper (or HRMS training record), as the food-handler record judges it. */
export interface FssaiPersonPaperVerdict {
  in_order: boolean;
  /** The State cell when not in order ("No expiry date", "No copy on file", "EXPIRED"). */
  words: string;
  /** Management words: why not ('' when in order). */
  why: string;
}

/**
 * A PERSON'S PAPER IN ORDER — what the food-handler record itself says
 * (readFssaiFoodHandlerCoverage), paper by paper. A paper is in order when
 *   · it serves a requirement that APPLIES to its holder (a food handler, or
 *     the FoSTaC supervisor, working here) and meets that requirement's rule:
 *     not expired, a live copy, and dated unless the rule takes an undated
 *     one — a medical or FoSTaC certificate with no expiry date is NOT in
 *     order (FSSAI_HANDLER_REQUIREMENTS.no_expiry_ok, owner ruling Q18);
 *   · and it is not the very paper a requirement of its holder rests on and
 *     FAILS. Ravi's undated FoSTaC certificate counts as his training, but the
 *     record's FoSTaC line names it as not in order, so it is not in order.
 * A paper that matches nobody on the register, a person who has left, or
 * somebody not marked a food handler, is not one the record counts: it is
 * absent from the map, and the caller treats it as not in order.
 *   · and its HOLDER is in order (2026-10-15): every requirement that applies
 *     to the person is met. Sita's in-house training is in order by itself,
 *     but her medical has expired; handed over, it names her on the
 *     inspector's copy, and beside Inspection Mode's food-handler list (which
 *     leaves her off) it tells the officer by omission who is not in order
 *     (§7 Q11). So none of a not-in-order person's papers goes into either
 *     copy; each stays on the page and the management copy as "Holder not in
 *     order", with what the person lacks.
 * Keys: 'document:<fssai_documents.id>' | 'hrms:<hr_training_assignments.id>'.
 */
export function fssaiPersonPapersInOrder(cov: FssaiHandlerCoverage): Map<string, FssaiPersonPaperVerdict> {
  const good = new Set<string>();
  const fails = new Map<string, { label: string; verdict_label: string }>();
  const seen = new Map<string, string>();
  /** Papers in force only from a day still to come (owner ruling 2026-10-15) → that day. */
  const notYet = new Map<string, string>();
  /** The person a paper belongs to, when that person is NOT in order overall. */
  const holderNotInOrder = new Map<string, { name: string; problems: string[] }>();
  for (const h of cov.handlers) {
    if (h.status !== 'active') continue;
    for (const req of FSSAI_HANDLER_REQUIREMENTS) {
      const c = h.coverage[req.key];
      if (!c || !c.required) continue;
      for (const e of c.evidence) {
        const key = `${e.source}:${e.id}`;
        // NOT YET IN FORCE: a renewal filed early does not stand before its
        // valid_from, so it is never a paper in order today, whatever its expiry.
        const ok = e.state !== 'expired' && !e.starts_on && e.copies > 0 &&
          (e.state === 'valid' || e.state === 'expiring' || (e.state === 'no_expiry' && req.no_expiry_ok));
        if (ok) good.add(key);
        if (e.state !== 'expired' && e.starts_on) notYet.set(key, e.starts_on);
        if (!seen.has(key)) {
          seen.set(key, e.state === 'expired' ? 'EXPIRED' : e.starts_on ? fssaiNotYetWords(e.starts_on) : e.copies <= 0 ? 'No copy on file' : e.state === 'no_expiry' ? 'No expiry date' : '');
        }
        if (!h.in_order && !holderNotInOrder.has(key)) {
          holderNotInOrder.set(key, { name: handlerName(h), problems: h.problems });
        }
      }
      if (!c.in_order && c.best) fails.set(`${c.best.source}:${c.best.id}`, { label: c.label, verdict_label: c.verdict_label });
    }
  }
  const out = new Map<string, FssaiPersonPaperVerdict>();
  for (const [key, stateWord] of seen) {
    const starts = notYet.get(key);
    if (starts) {
      // Its reason is its date, whoever holds it and whatever else they lack.
      out.set(key, { in_order: false, words: fssaiNotYetWords(starts), why: notYetWhy(starts, cov.today) });
      continue;
    }
    const f = fails.get(key);
    const holder = holderNotInOrder.get(key);
    if (good.has(key) && !f && holder) {
      out.set(key, {
        in_order: false,
        words: 'Holder not in order',
        why: `it is in order by itself, but its holder is not (${holder.problems.join(', ') || 'a certificate is not in order'}), ` +
          'and the handover leaves out every certificate of a person who is not in order, so that it never names them',
      });
      continue;
    }
    if (good.has(key) && !f) { out.set(key, { in_order: true, words: '', why: '' }); continue; }
    const words = f ? f.verdict_label : stateWord || 'Not in order';
    out.set(key, {
      in_order: false,
      words,
      why: f
        ? `the food-handler record judges it not in order (${f.label}: ${f.verdict_label})`
        : `the food-handler record does not count it (${words})`,
    });
  }
  return out;
}

/** What fssaiHandoverPaperJudge needs of one fssai_documents row. */
export interface FssaiHandoverPaperIn extends FssaiPaperDates {
  id: string;
  reminder_days?: unknown;
  /** LIVE copies stored on it: status <> 'void' and the image still there. */
  copies: number;
}

export interface FssaiHandoverPaperVerdict {
  state: FssaiDocState;
  in_order: boolean;
  until: string;
  state_words: string;
  why: string;
  /** Its valid_from when that is after today — NOT in force yet; '' when it has started. */
  starts_on: string;
}

/**
 * THE ONE JUDGE of "is this paper one the record holds in order today", for
 * the inspector's copy of the audit file AND Inspection Mode's handover. Built
 * once per read (the food-handler coverage is read once, on the first person's
 * certificate it is asked about). Never throws: a coverage that cannot be read
 * leaves every person's certificate NOT in order — out of the handover, never
 * in it by default.
 */
export function fssaiHandoverPaperJudge(db: Database.Database, today: string): (d: FssaiHandoverPaperIn) => FssaiHandoverPaperVerdict {
  let persons: Map<string, FssaiPersonPaperVerdict> | null = null;
  /** Why no person's certificate can be judged at all ('' when the register was read). */
  let noRegister = '';
  const personVerdicts = (): Map<string, FssaiPersonPaperVerdict> => {
    if (persons) return persons;
    try {
      const cov = readFssaiFoodHandlerCoverage(db, { today });
      if (!cov.available) noRegister = 'the food-handler register is not in this copy of the database yet, so nobody can say whose certificate is in order';
      persons = fssaiPersonPapersInOrder(cov);
    } catch (e: any) {
      console.error('[fssai/audit-file] food-handler coverage failed:', e?.message || e);
      noRegister = 'the food-handler register could not be read, so nobody can say whose certificate is in order';
      persons = new Map();
    }
    return persons;
  };
  return (d) => {
    const reminder = Number.isFinite(Number(d.reminder_days)) ? Number(d.reminder_days) : FSSAI_DOC_REMINDER_DAYS;
    const state = fssaiDocState(d.expiry_date, today, reminder);
    const f = fssaiPaperInForce(d, state, today);
    let inOrder = f.in_force;
    let words = f.state_words;
    let why = f.why;
    // NOT YET IN FORCE (owner ruling 2026-10-15): in force only from its
    // valid_from — a renewal filed early is "Not yet in force (from <date>)".
    const nyf = fssaiPaperNotYetInForce(d, today);
    if (inOrder && nyf.starts_on) { inOrder = false; words = nyf.state_words; why = nyf.why; }
    if (inOrder && fssaiDocType(d.doc_type)?.scope === 'person') {
      const v = personVerdicts().get(`document:${d.id}`);
      if (!v) {
        inOrder = false;
        words = 'Not counted';
        why = noRegister || 'it belongs to nobody working here as a food handler on the register, so the food-handler record does not count it';
      } else if (!v.in_order) {
        inOrder = false;
        words = v.words;
        why = v.why;
      }
    }
    if (inOrder && d.copies <= 0) { inOrder = false; why = 'no live copy of it is attached'; }
    return { state, in_order: inOrder, until: f.until, state_words: words, why, starts_on: f.in_force ? nyf.starts_on : '' };
  };
}

/** A visit's report copies, as the one judge holds them (fssaiVisitReportInOrder). */
export interface FssaiVisitReportVerdict {
  /** LIVE copies of the visit's report the record holds in order today: its own pages + the linked document's, when that is in order. */
  copies: number;
  /** The linked document is live, has a live copy, and the judge holds it in order today. */
  document_in_order: boolean;
  /** Management words: why the linked document is not counted ('' when it is, or when it has no copy — document_problem says that). */
  document_why: string;
  /** "Hygiene audit certificate 2025, no. AUD-EXP-1" — '' with no linked document. */
  document_label: string;
}

/**
 * THE LAST VISIT'S REPORT, through the one judge (fssaiHandoverPaperJudge). The
 * closure lane counts the linked document's live scans as copies of the
 * visit's report (ev.report.copies), whatever the document's dates — but a
 * linked report filed with an expiry date that has passed (a one-year
 * third-party audit certificate) is not a paper in force, exactly as it is not
 * on "Audit reports on file" or Inspection Mode's documents. So its copies
 * count, and go into the inspector's copy, only while the judge holds it in
 * order; the pages photographed onto the visit itself are the visit's own
 * record and always count. Record 20 and Inspection Mode's previous visits
 * both read the count here.
 */
export function fssaiVisitReportInOrder(
  db: Database.Database,
  judge: (d: FssaiHandoverPaperIn) => FssaiHandoverPaperVerdict,
  ev: FssaiVisitClosureEvidence,
): FssaiVisitReportVerdict {
  const own = ev.report.files.filter((f) => f.status === 'active' && f.has_image).length;
  const doc = ev.report.document;
  if (!doc || doc.voided) return { copies: own, document_in_order: false, document_why: '', document_label: doc ? doc.title : '' };
  const label = [doc.title || doc.doc_type_label, doc.reference_no ? `no. ${doc.reference_no}` : ''].filter(Boolean).join(', ');
  const r = db.prepare(
    `SELECT doc_type, expiry_date, valid_from, issued_on, created_at, reminder_days FROM fssai_documents WHERE id = ?`,
  ).get(doc.id) as any;
  if (!r) return { copies: own, document_in_order: false, document_why: '', document_label: label };
  const v = judge({
    id: doc.id, doc_type: s(r.doc_type), expiry_date: s(r.expiry_date), valid_from: s(r.valid_from), issued_on: s(r.issued_on),
    created_on: dateOf(r.created_at), reminder_days: r.reminder_days, copies: doc.live_scans,
  });
  return {
    copies: own + (v.in_order ? doc.live_scans : 0),
    document_in_order: v.in_order,
    document_why: !v.in_order && doc.live_scans > 0 ? v.why : '',
    document_label: label,
  };
}

function docLabel(d: DocRow): string {
  return [d.title || d.type_label, d.reference_no ? `no. ${d.reference_no}` : ''].filter(Boolean).join(', ');
}

/**
 * Every file on these records of ONE register — live AND voided, each marked.
 * A caller never decides by itself whether a voided file counts: it does not.
 * Anything that counts copies tests `isLiveCopy`, and buildAuditFile() moves
 * the voided ones out of `scans` for every record at the end.
 */
function readScans(db: Database.Database, entityTable: string, ids: string[], label: (id: string) => string): AuditFileScan[] {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return [];
  const out: AuditFileScan[] = [];
  for (let i = 0; i < uniq.length; i += 400) {
    const chunk = uniq.slice(i, i + 400);
    const rows = db.prepare(
      `SELECT id, entity_table, entity_id, mime, filename, size_bytes, caption, created_at, image_dropped_at,
              status, voided_at, voided_by, void_reason,
              (data_uri <> '') AS has_image
         FROM fssai_attachments
        WHERE entity_table = ? AND entity_id IN (${chunk.map(() => '?').join(',')})
        ORDER BY created_at ASC, rowid ASC`,
    ).all(entityTable, ...chunk) as any[];
    for (const r of rows) out.push(shapeScan(r, label(s(r.entity_id))));
  }
  return out;
}

function shapeScan(r: any, recordLabel: string): AuditFileScan {
  const isVoid = s(r.status) === 'void' || !!s(r.voided_at);
  return {
    attachment_id: s(r.id ?? r.attachment_id),
    entity_table: s(r.entity_table),
    entity_id: s(r.entity_id),
    record_label: recordLabel,
    filename: s(r.filename),
    mime: s(r.mime),
    size_bytes: intOr(r.size_bytes),
    caption: s(r.caption),
    created_at: s(r.created_at),
    has_image: r.has_image === true || intOr(r.has_image) === 1,
    image_dropped_at: s(r.image_dropped_at),
    status: isVoid ? 'void' : 'active',
    voided_at: s(r.voided_at),
    voided_by: s(r.voided_by),
    void_reason: s(r.void_reason),
    in_handover: r.in_handover !== false,
  };
}

/**
 * Keep a list-beside-it table (and its files) OUT of the inspector's copy. A
 * record whose own register has nothing to print must not reach the handover
 * on a side register alone: "14. Waste disposal record" holding only the
 * collector's agreement, or "18. FIFO/FEFO checklist" holding only the expiry
 * register, implies a record that is not on file (§7 Q11). The page and the
 * management copy still show every line.
 */
function keepOutOfHandover(tables: AuditFileTable[], scans: AuditFileScan[] = []): void {
  for (const t of tables) {
    for (const r of t.rows) r.in_handover = false;
    t.handover_rows = 0;
  }
  for (const sc of scans) sc.in_handover = false;
}

/** A copy anyone can read: live (not voided) and its image still stored. */
function isLiveCopy(sc: AuditFileScan): boolean {
  return sc.status !== 'void' && sc.has_image;
}

/** A closure-lane file (FssaiClosureFile) in this file's scan shape. */
function closureScan(f: FssaiClosureFile, recordLabel: string): AuditFileScan {
  return shapeScan({ ...f, id: f.attachment_id }, recordLabel);
}

function readDocs(ctx: Ctx, types: string[]): DocRow[] {
  const { db, today } = ctx;
  const hasHandler = !!db.prepare(`SELECT 1 FROM pragma_table_xinfo('fssai_documents') WHERE name = 'handler_id'`).get();
  // Current papers — and a superseded one whose renewal (the Documents screen's
  // Renew) is NOT YET in force: until the renewal's valid_from that is the paper
  // in force (owner ruling 2026-10-15), judged below exactly like a current one,
  // by its own dates and its own scans. The renewal itself is read too and is
  // "Not yet in force (from <date>)", as when the two were filed side by side.
  const counts = fssaiDocCountsSql('d', fssaiSupersededStillInForce(db, today));
  const rows = db.prepare(
    `SELECT d.id, d.doc_type, d.title, d.reference_no, d.issuer, d.issued_on, d.valid_from, d.expiry_date,
            d.reminder_days, d.vendor_id, d.person_email, d.equipment_id, d.created_at,
            ${hasHandler ? 'd.handler_id' : `''`} AS handler_id,
            (SELECT v.name FROM vendors v WHERE v.id = d.vendor_id) AS vendor_name,
            (SELECT u.name FROM users u WHERE lower(u.email) = lower(d.person_email) AND d.person_email <> '' LIMIT 1) AS person_name,
            ${ctx.present.has('fssai_equipment') ? `(SELECT e.name FROM fssai_equipment e WHERE e.id = d.equipment_id)` : `''`} AS equipment_name
       FROM fssai_documents d
      WHERE d.doc_type IN (${types.map(() => '?').join(',')})
        AND ${counts.sql} AND ${LIVE('d')}
      ORDER BY (CASE WHEN d.expiry_date = '' THEN 1 ELSE 0 END) ASC, d.expiry_date DESC, d.created_at DESC`,
  ).all(...types, ...counts.args) as any[];

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
      handler_id: s(r.handler_id),
      holder: '',
      equipment_id: s(r.equipment_id),
      equipment_name: s(r.equipment_name),
      created_on: dateOf(r.created_at),
      reminder_days: r.reminder_days,
      stored: 0,
      voided: 0,
      dropped_at: '',
      scans: [],
      in_order: false,
      until: '',
      starts_on: '',
      state_words: '',
      why_not: '',
    };
  });
  // Whose certificate — the food-handler register first (a cook with no login
  // has a name there and nowhere else), then the login. Person scope only.
  const personDocs = docs.filter((d) => fssaiDocType(d.doc_type)?.scope === 'person');
  if (personDocs.length) {
    const holders = fssaiDocumentHolders(db, personDocs.map((d) => ({ id: d.id, handler_id: d.handler_id, person_email: d.person_email })));
    for (const d of personDocs) d.holder = holders.get(d.id)?.label || d.person_name || d.person_email;
  }

  const byId = new Map(docs.map((d) => [d.id, d]));
  const scans = docs.length && ctx.present.has('fssai_attachments')
    ? readScans(db, 'fssai_documents', docs.map((d) => d.id), (id) => {
      const d = byId.get(id);
      return d ? docLabel(d) : 'Document';
    })
    : [];
  for (const sc of scans) {
    const d = byId.get(sc.entity_id);
    if (!d) continue;
    d.scans.push(sc);
    if (sc.status === 'void') { d.voided++; continue; }   // kept, listed apart, never a copy
    if (sc.has_image) d.stored++;
    else if (sc.image_dropped_at && sc.image_dropped_at > d.dropped_at) d.dropped_at = sc.image_dropped_at;
  }
  // IN ORDER TODAY — the one judge (fssaiHandoverPaperJudge), the same one
  // Inspection Mode asks. A paper that is not — expired, lapsed by its period,
  // a person's certificate the food-handler record does not count, no live
  // copy — stays on the page and the management copy with the reason in its
  // State cell, and neither its row nor its scan goes into the inspector's
  // copy ("those in force").
  for (const d of docs) {
    const v = ctx.paper({
      id: d.id, doc_type: d.doc_type, expiry_date: d.expiry_date, valid_from: d.valid_from, issued_on: d.issued_on,
      created_on: d.created_on, reminder_days: d.reminder_days, copies: d.stored,
    });
    d.state = v.state;
    d.in_order = v.in_order;
    d.until = v.until;
    d.starts_on = v.starts_on;
    d.state_words = v.state_words;
    d.why_not = v.why;
    for (const sc of d.scans) sc.in_handover = v.in_order;
  }
  return docs;
}

/** The Copy cell of a document row. */
function copyWords(d: DocRow): string {
  return d.stored ? plural(d.stored, 'scan') : d.voided ? 'voided only' : 'none';
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
      d.state_words || STATE_WORDS[d.state],
      copyWords(d),
    ],
    '/fssai/documents',
    !d.in_order || !d.stored ? 'bad' : d.state === 'expiring' ? 'warn' : '',
    // Only a paper the record judges IN ORDER today (DocRow.in_order, the one
    // judge): a row with no copy is the number without the paper; an EXPIRED or
    // lapsed one is not in force — the inspector's copy says it holds the
    // documents "in force" on the day, and such a line is a sentence about a
    // lapse (§7 Q11); a person's certificate the food-handler record does not
    // count names someone not in order. All stay on the page and the
    // management copy, the reason in the State cell.
    d.in_order,
  ));
}

interface DocVerdict {
  status: AuditFileStatus;
  problems: string[];
  best: DocRow | null;
  lapses_on: string;
  /** None is in force today, but one on file comes into force later: the first such day ('' otherwise). */
  starts_on: string;
}

/**
 * The paper rule, applied to one set of documents that answer the same need
 * (one licence, one person's certificate, one unit's calibration).
 *   none on file → MISSING · all lapsed → MISSING · no copy attached → MISSING
 *   the best one inside its renewal window → EXPIRING · otherwise PRESENT.
 * "Best" = in force, with a copy, latest expiry (a dated one beats an undated
 * one, because an undated one cannot be judged either way).
 * NOT YET IN FORCE (owner ruling 2026-10-15): a paper whose valid_from is still
 * to come (DocRow.starts_on — a renewal filed early) is on file, but it is not
 * what the outlet holds today, so it is never the best: the record is judged
 * on what is in force today. With nothing else in force it is MISSING, the
 * problem naming the day the filed one starts; a current paper inside its
 * renewal window is not flagged EXPIRING when its renewal is filed, with a
 * copy, and starts by the day after it lapses.
 */
function judgeDocs(docs: DocRow[], what: string, today: string): DocVerdict {
  if (!docs.length) return { status: 'missing', problems: [`No ${what} is on file.`], best: null, lapses_on: '', starts_on: '' };

  /** Filed ahead of their valid_from, the first to start first. */
  const pending = docs.filter((d) => d.starts_on && d.state !== 'expired')
    .sort((a, b) => (a.starts_on < b.starts_on ? -1 : a.starts_on > b.starts_on ? 1 : 0));
  const inForce = docs.filter((d) => d.state !== 'expired' && !d.starts_on);
  if (!inForce.length) {
    const lapsed = docs.filter((d) => !d.starts_on);
    const last = lapsed.length ? [...lapsed].sort((a, b) => (a.expiry_date < b.expiry_date ? 1 : -1))[0] : null;
    const next = pending[0] || null;
    return {
      status: 'missing',
      problems: [[
        last ? `The ${what} on file (${docLabel(last)}) expired on ${last.expiry_date} — ${until(last.expiry_date, today)}.` : '',
        next ? `${docLabel(next)} is on file, but it is in force only from ${next.starts_on} — ${until(next.starts_on, today)}; until then no ${what} is in force.` : '',
      ].filter(Boolean).join(' ')],
      best: null,
      lapses_on: last ? last.expiry_date : '',
      starts_on: next ? next.starts_on : '',
    };
  }

  const withCopy = inForce.filter((d) => d.stored > 0);
  if (!withCopy.length) {
    const d = inForce[0];
    const why = d.dropped_at
      ? `its scan was removed on ${d.dropped_at.slice(0, 10)}`
      : d.voided
        ? `its only ${d.voided === 1 ? 'scan was' : `${d.voided} scans were`} voided as attached by mistake, and no other copy is attached`
        : 'no scan or photograph of it is attached';
    return {
      status: 'missing',
      problems: [`${docLabel(d)} is recorded, but ${why} — the file has the number, not the copy.`],
      best: d,
      lapses_on: d.expiry_date,
      starts_on: '',
    };
  }

  const best = [...withCopy].sort((a, b) => {
    if (!!a.expiry_date !== !!b.expiry_date) return a.expiry_date ? -1 : 1;
    return a.expiry_date < b.expiry_date ? 1 : a.expiry_date > b.expiry_date ? -1 : 0;
  })[0];
  if (best.state === 'expiring') {
    // Its renewal already filed (with a copy) and starting by the day after it
    // lapses: there is nothing to renew. Starting later leaves a gap: say so.
    const dayAfter = addDaysISO(best.expiry_date, 1);
    const renewal = pending.find((d) => d.stored > 0 && d.starts_on <= dayAfter);
    const later = renewal ? null : pending.find((d) => d.stored > 0) || null;
    if (!renewal) {
      return {
        status: 'expiring',
        problems: [`${docLabel(best)} expires on ${best.expiry_date} — ${until(best.expiry_date, today)}. ` +
          (later
            ? `Its renewal on file (${docLabel(later)}) comes into force only on ${later.starts_on}, so none will be in force from ${dayAfter} until then.`
            : 'Renew it before then.')],
        best,
        lapses_on: best.expiry_date,
        starts_on: '',
      };
    }
  }
  return { status: 'present', problems: [], best, lapses_on: best.expiry_date, starts_on: '' };
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
  /**
   * SQL (alias t = fssai_templates) TRUE for a template that is NOT one of the
   * authority's three Hyderabad audit pages. Every checklist-round record ANDs
   * it in: a monthly self-audit of the whole checklist is not the daily
   * cleaning round, the storage round or the pest monitoring sheet, even where
   * it has a section of that name (CHECKLIST 3 has "Pests").
   */
  notHydAudit: string;
  /** The one "in order today" judge for every paper (fssaiHandoverPaperJudge). */
  paper: (d: FssaiHandoverPaperIn) => FssaiHandoverPaperVerdict;
}

type Part = Omit<AuditFileItem, 'n' | 'key' | 'title'>;

function blank(): Part {
  return {
    status: 'missing', held: false, headline: '', problems: [], todo: '', lapses_on: '', basis: '',
    links: [], summary: [], tables: [], scans: [], voided_scans: [],
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
  // "On file" counts only what the inspector's copy carries — the papers in
  // order with their copy — so the box can never read 2 above a table of one.
  // The rest is management's figure.
  const handed = docs.filter((d) => d.in_order).length;
  p.summary = [
    { label: 'On file', value: String(handed) },
    ...(docs.length > handed ? [{ label: 'Lapsed or without a copy', value: String(docs.length - handed), mgmt: true as const }] : []),
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
    `a filed water-test document until its expiry; a municipal water bill for ${CURRENCY_DAYS.water_bill} days from its date. EXPIRING inside ${WARN_DAYS} days of the end. ` +
    'Each counts only with a copy of the paper attached — a lab report typed in under Water & Ice Checks with no photograph or scan of the laboratory\'s report is the number, not the report.';
  const todo =
    'Get the water tested by a laboratory and record the report under Water & Ice Checks (kind "Lab report") with a photograph or scan of the laboratory\'s report attached, or file the latest municipal water bill under Documents & Certificates as "Municipal water bill" with a scan. ' +
    'A lab report already recorded without its copy: file the laboratory\'s report under Documents & Certificates as "Water test report", with its scan.';

  const ends: Array<{ end: string; label: string }> = [];
  const rows: AuditFileRow[] = [];
  /** Lab reports recorded with no live copy attached, in words. */
  const noCopy: string[] = [];
  let held = 0;

  if (ctx.present.has('fssai_water_tests')) {
    const labs = ctx.db.prepare(
      `SELECT id, business_date, lab_name, lab_licence_no, report_no, sample_date, report_date, result, next_due_date, is_fail
         FROM fssai_water_tests w
        WHERE w.test_kind = 'lab_report' AND ${LIVE('w')}
        ORDER BY business_date DESC, created_at DESC`,
    ).all() as any[];
    held += labs.length;
    // A COPY IS THE RECORD (see the header). A lab report typed in under Water
    // & Ice is the app knowing the report's number and result — the laboratory's
    // paper is the record the authority asks for. So a lab report counts, and is
    // printed in the inspector's copy, only with a LIVE copy of it attached; one
    // without is listed (page, management copy) as "no copy attached".
    const labScans = readScans(ctx.db, 'fssai_water_tests', labs.map((r) => s(r.id)), () => 'Laboratory water report');
    const liveByLab = new Map<string, number>();
    const voidByLab = new Map<string, number>();
    for (const sc of labScans) {
      const m = sc.status === 'void' ? voidByLab : isLiveCopy(sc) ? liveByLab : null;
      if (m) m.set(sc.entity_id, (m.get(sc.entity_id) || 0) + 1);
    }
    /** Lab reports the inspector's copy may carry: a live copy, and in force today. */
    const inForceLab = new Set<string>();
    for (const r of labs) {
      const copies = liveByLab.get(s(r.id)) || 0;
      const { from, until: end } = fssaiWaterLabUntil(r);
      const label = `laboratory water report${r.report_no ? ` no. ${s(r.report_no)}` : ''}`;
      if (end && copies > 0) ends.push({ end, label });
      else if (!copies) {
        noCopy.push(`The ${label}${from ? ` of ${from}` : ''} is recorded under Water & Ice Checks, but ${voidByLab.get(s(r.id))
          ? 'its only copy was voided as attached by mistake, and no other copy is attached'
          : 'no copy of the laboratory\'s report is attached'} — the file has the number, not the report.`);
      }
      // IN FORCE BY ITS PERIOD: a lab report stands until the next-test date on
      // it (or CURRENCY_DAYS.water_test from the report). Past that it is as
      // lapsed as an expired licence — on the page and the management copy, with
      // the date it ran out, but never in the inspector's copy ("those in force").
      const lapsed = !!end && end < ctx.today;
      const inForce = copies > 0 && !!end && !lapsed;
      if (inForce) inForceLab.add(s(r.id));
      rows.push(row(
        ['Lab report', [s(r.lab_name), s(r.lab_licence_no)].filter(Boolean).join(' · '), s(r.report_no), from, end || '—',
          [intOr(r.is_fail) ? 'FAIL' : (s(r.result) || 'Recorded'), copies ? plural(copies, 'scan') : 'no copy attached',
            lapsed ? `lapsed ${end}` : ''].filter(Boolean).join(' · ')],
        '/fssai/water-ice', intOr(r.is_fail) || !inForce ? 'bad' : '', inForce,
      ));
    }
    for (const sc of labScans) sc.in_handover = inForceLab.has(sc.entity_id);
    p.scans.push(...labScans);
  }

  /** Filed ahead of their valid-from date: on file, not in force yet (never the current one). */
  let waterNotYet: DocRow[] = [];
  if (ctx.present.has('fssai_documents')) {
    const docs = readDocs(ctx, ['water_test', 'water_bill']);
    held += docs.length;
    waterNotYet = docs.filter((d) => d.starts_on && d.stored > 0);
    for (const d of docs) {
      const isBill = d.doc_type === 'water_bill';
      // d.until: its expiry, else its period from its date (fssaiPaperUntil —
      // a bill the quarter it was issued in). In the inspector's copy only
      // while it is in order (d.in_order: in force by that date, with a copy).
      const end = d.until;
      // A document counts only with its copy (see the header), and only once in
      // force: one filed ahead of its valid-from date is not current yet.
      if (end && d.stored > 0 && !d.starts_on) ends.push({ end, label: isBill ? `water bill (${docLabel(d)})` : `water test report (${docLabel(d)})` });
      rows.push(row(
        [isBill ? 'Water bill' : 'Water test document', d.issuer, d.reference_no, d.issued_on || d.valid_from || d.created_on, end || '—',
          [d.stored ? plural(d.stored, 'scan') : 'no copy attached', d.in_order || !d.stored ? '' : d.state_words].filter(Boolean).join(' · ')],
        '/fssai/documents', d.in_order ? '' : 'bad', d.in_order,
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
  if (!best && held) p.problems = ['Water records are on file, but none is a dated laboratory report or a filed document with a copy attached.'];
  if (p.status !== 'present' && waterNotYet.length) {
    p.problems.push(...waterNotYet.map((d) => `${docLabel(d)} is on file, but it is in force only from ${d.starts_on} — ${until(d.starts_on, ctx.today)}.`));
  }
  // A lab report recorded without its copy is named while the record is not
  // PRESENT — it is the quickest way to close it (attach the paper).
  if (p.status !== 'present') p.problems.push(...noCopy);
  p.lapses_on = best?.end || '';
  // The newest paper with a copy may itself have run out: then nothing is
  // current, and the headline says so rather than calling it "Current".
  const bestLapsed = !!best && best.end < ctx.today;
  p.headline = best
    ? bestLapsed ? `Latest: ${best.label}, ran out on ${best.end}` : `Current: ${best.label}, good until ${best.end}`
    : held ? `${plural(held, 'record')} on file, none current with a copy` : 'Nothing on file';
  const withCopy = rows.filter((r) => r.in_handover).length;
  p.summary = [
    // Only what the inspector's copy can show: a record with its copy, in force.
    { label: 'On file', value: String(withCopy) },
    ...(held > withCopy ? [{ label: 'Without a copy, or lapsed', value: String(held - withCopy), mgmt: true as const }] : []),
    // A "good until" date in the past is a sentence about a lapse: management's.
    bestLapsed || !best ? { label: 'Good until', value: best?.end || '—', mgmt: true as const } : { label: 'Good until', value: best.end },
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
    `Both halves are needed. The agreement: a pest-control contract in force with a copy attached. The reports: the last completed visit, with a photograph of the technician's job sheet or service report attached to it, whose next visit date has not passed ` +
    `(or within ${CURRENCY_DAYS.pest_visit} days when the technician wrote none) — a visit typed in with no copy of the agency's report is the visit, not the report. ` +
    `EXPIRING when the contract is inside its renewal window or the next visit is due within ${PEST_WARN_DAYS} days. ` +
    'What each visit applied — product, CIB&RC registration number, batch, expiry, dilution, quantity, method and where — is printed with it; ' +
    'EXPIRING too when the last visit does not say what was applied.';
  const todo =
    'File the pest-control agreement under Documents & Certificates as "Pest control contract" with a scan, and record every visit under Pest Control Logs with a photograph of the technician\'s job sheet or report attached to it.';
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

  // THE REPORT IS THE AGENCY'S PAPER (A COPY IS THE RECORD — see the header).
  // The visit row is the outlet's own entry; the "report" the authority asks
  // for is the technician's job sheet / service report, so the LAST visit
  // counts only with a LIVE copy of it on the visit. A voided job sheet is
  // never that copy. The agreement half is judged the same way (judgeDocs).
  const from = periodicFrom(ctx);
  const inWindow = visits.filter((v) => s(v.business_date) >= from);
  // Every listed visit's files are read, so each visit's line can be judged on
  // its own copy; the images drawn stay the last visit and the six newest.
  const allVisitScans = readScans(ctx.db, 'fssai_pest_services',
    [...(last ? [s(last.id)] : []), ...inWindow.map((v) => s(v.id))],
    (id) => { const v = visits.find((x) => s(x.id) === id); return v ? `Pest-control report ${s(v.report_no) || s(v.service_no)} (${s(v.business_date)})` : 'Pest-control report'; });
  const drawn = new Set([...(last ? [s(last.id)] : []), ...inWindow.slice(0, 6).map((v) => s(v.id))]);
  const visitScans = allVisitScans.filter((sc) => drawn.has(sc.entity_id) || sc.status === 'void');
  /** Visits with a LIVE copy of the agency's report on them — the only ones that are reports. */
  const reported = new Set(allVisitScans.filter(isLiveCopy).map((sc) => sc.entity_id));
  if (last) {
    const own = visitScans.filter((sc) => sc.entity_id === s(last.id));
    if (!own.some(isLiveCopy)) {
      const why = own.some((sc) => sc.status === 'void')
        ? 'its only job sheet was voided as attached by mistake, and no other copy is attached'
        : 'no photograph of the technician\'s job sheet or service report is attached to it';
      r = {
        status: 'missing',
        problems: [...r.problems, `The last visit (${s(last.business_date)}${s(last.report_no) ? `, report no. ${s(last.report_no)}` : ''}) is recorded, but ${why} — the file has the visit, not the report.`],
      };
    }
  }

  // WHAT EACH VISIT APPLIED (#78) — a pest-control report that does not say
  // which chemical went down, where, of what registration and batch, is half a
  // report. Read through the pest lane's own reader so '[]' is "not recorded",
  // never "nothing applied". The LAST visit with nothing recorded turns the
  // record EXPIRING (the job sheet can still be copied in, once, with an audit
  // row); older visits are listed and named.
  const chem = ctx.present.has('fssai_pest_services')
    ? readPestChemicalsApplied(ctx.db, { from, to: ctx.today })
    : null;
  const lastChem = last && chem ? chem.visits.find((v) => v.id === s(last.id)) : undefined;
  if (lastChem && lastChem.state === 'not_recorded') {
    r = {
      status: worst(r.status, 'expiring'),
      problems: [...r.problems, `The last visit (${s(last.business_date)}) does not say which chemicals were applied. Copy them in from the technician's job sheet on Pest Control Logs.`],
    };
  }

  p.status = worst(c.status, r.status);
  p.problems = [...c.problems, ...r.problems];
  p.lapses_on = earliest([c.lapses_on, end]);
  p.headline = [
    c.best ? `Agreement: ${docLabel(c.best)}${c.best.expiry_date ? `, until ${c.best.expiry_date}` : ''}` : 'No agreement in force',
    last ? `last visit ${s(last.business_date)} by ${s(last.vendor_name) || 'the agency'}` : 'no visit recorded',
  ].join(' · ');
  // The inspector's copy carries only the visits whose report is on file (a
  // live copy of the job sheet), so its figures count those. A figure about a
  // visit the copy does not carry, or a next-visit date already past, is a
  // sentence about a gap: management's (mgmt).
  const lastReported = !!last && reported.has(s(last.id));
  const reportedInWindow = inWindow.filter((v) => reported.has(s(v.id))).length;
  const productsHanded = (chem?.visits || []).filter((v) => reported.has(v.id) && v.state === 'listed')
    .reduce((a, v) => a + v.chemicals.length, 0);
  const nextPast = !!end && end < ctx.today;
  p.summary = [
    { label: 'Agreement', value: c.best ? (c.best.expiry_date || 'no expiry') : '—', ...(c.best?.in_order ? {} : { mgmt: true as const }) },
    // "0 service reports" on paper handed over is a sentence about a gap.
    { label: 'Service reports', value: String(reportedInWindow), ...(reportedInWindow ? {} : { mgmt: true as const }) },
    ...(reportedInWindow !== inWindow.length ? [{ label: 'Visits without a report copy', value: String(inWindow.length - reportedInWindow), mgmt: true as const }] : []),
    { label: 'Visits recorded', value: String(visits.length), mgmt: true },
    lastReported ? { label: 'Last visit', value: s(last.business_date) } : { label: 'Last visit', value: last ? s(last.business_date) : '—', mgmt: true as const },
    lastReported && !nextPast ? { label: 'Next due', value: end || '—' } : { label: 'Next due', value: end || '—', mgmt: true as const },
    ...(chem ? [{ label: 'Products applied', value: String(productsHanded), ...(reportedInWindow ? {} : { mgmt: true as const }) }] : []),
  ];
  const chemById = new Map((chem?.visits || []).map((v) => [v.id, v]));
  const chemWords = (id: string): string => {
    const v = chemById.get(id);
    if (!v) return '';
    if (v.state === 'none_applied') return `None applied${v.none_note ? ` (${v.none_note})` : ''}`;
    if (v.state === 'not_recorded') return 'Not recorded';
    return v.chemicals.map((c) => c.name).filter(Boolean).join(', ');
  };
  // One line per product, under the visit that applied it. A visit that applied
  // nothing says so in its own words; one whose list nobody recorded is a gap,
  // so it stays on the page and the management copy but not in the handover.
  // And a visit with no live copy of its report is the visit, not the report
  // (A COPY IS THE RECORD): neither its line nor what it applied goes into the
  // inspector's copy — printed there, it would read as a report on file.
  const chemRows: AuditFileRow[] = [];
  for (const v of [...(chem?.visits || [])].reverse()) {
    const visit = `${v.business_date} · ${v.report_no || v.service_no}`;
    const hasReport = reported.has(v.id);
    if (v.state === 'listed') {
      for (const c of v.chemicals) {
        const expiredOnDay = !!c.expiry && c.expiry < v.business_date;
        chemRows.push(row([
          visit, [c.name, c.active_ingredient].filter(Boolean).join(' — '), c.licence_no || '—', c.batch,
          c.expiry ? `${c.expiry}${expiredOnDay ? ' (EXPIRED when used)' : ''}` : '', c.dilution, [c.qty, c.uom].filter(Boolean).join(' '),
          [c.method, c.target_pest].filter(Boolean).join(' · '), c.area,
        ], '/fssai/pest-control', expiredOnDay || !c.licence_no ? 'warn' : '', hasReport));
      }
    } else if (v.state === 'none_applied') {
      chemRows.push(row([visit, `None applied${v.none_note ? ` — ${v.none_note}` : ''}`, '', '', '', '', '', '', ''], '/fssai/pest-control', '', hasReport));
    } else {
      chemRows.push(row([visit, 'Not recorded on this visit', '', '', '', '', '', '', ''], '/fssai/pest-control', 'bad', false));
    }
  }
  p.tables = [
    table('Agreement', DOC_COLUMNS, docRows(docs), ctx.limit, 'No agreement is on file.'),
    table(`Service reports from ${from}`, [
      { label: 'Date', width: 0.9 }, { label: 'Agency', width: 1.5 }, { label: 'Report no.', width: 1 },
      { label: 'Technician', width: 1.1 }, { label: 'Areas', width: 1.5 }, { label: 'Findings', width: 1.7 },
      { label: 'Chemicals', width: 1.5 }, { label: 'Next due', width: 0.9 },
    ], inWindow.map((v) => {
      const hasReport = reported.has(s(v.id));
      return row([
        s(v.business_date), [s(v.vendor_name), s(v.agency_licence_no)].filter(Boolean).join(' · '),
        `${s(v.report_no) || s(v.service_no)}${hasReport ? '' : ' (no report copy)'}`,
        // A next-visit date already past is the gap the problems name, never a cell (dueCell).
        s(v.technician_name), s(v.areas_covered), s(v.findings), chemWords(s(v.id)), dueCell(v.next_due_date, ctx.today),
      ], '/fssai/pest-control', hasReport ? '' : 'bad', hasReport);
    }), ctx.limit),
    table(`Chemicals applied from ${from}`, [
      { label: 'Visit', width: 1.2 }, { label: 'Product — active ingredient', width: 2 }, { label: 'CIB&RC reg. no.', width: 1.5 },
      { label: 'Batch', width: 0.7 }, { label: 'Expiry', width: 1 }, { label: 'Dilution', width: 0.9 }, { label: 'Qty', width: 0.6 },
      { label: 'Method · target', width: 1.1 }, { label: 'Where', width: 1.3 },
    ], chemRows, ctx.limit, 'No completed visit in these dates.'),
  ];
  // A product line with no registration number, or past its expiry on the day,
  // is coloured on its row (and the pest print marks it). It does not by itself
  // change the status: the line asks for the records, and these ARE the records.
  p.scans = [...docs.flatMap((d) => d.scans), ...visitScans];
  if (p.status !== 'present') p.todo = todo;
  return p;
}

/* 6, 7 ─ the food handlers, each by name (the food-handler register) */
const HANDLERS_LINK: AuditFileLink = { href: '/fssai/documents/food-handlers', label: 'Food Handlers' };

/** "Ravi Kumar (FH-0001)" */
function handlerName(h: { full_name: string; handler_no: string }): string {
  return h.handler_no ? `${h.full_name} (${h.handler_no})` : h.full_name;
}

/** "Valid until 2027-02-28" / "EXPIRED 2026-10-11" / "MISSING" — one requirement, in words. */
function verdictCell(c: FssaiFoodHandlerWithCoverage['coverage'][FssaiHandlerRequirementKey]): string {
  if (!c.required) return '—';
  const exp = c.best?.expiry_date || '';
  if (c.verdict === 'valid') return exp ? `Valid until ${exp}` : 'Valid';
  if (c.verdict === 'expiring') return `Expiring ${exp}`;
  if (c.verdict === 'expired') return `EXPIRED ${exp}`;
  if (c.verdict === 'no_expiry') return c.in_order ? 'On file (no expiry)' : 'No expiry date';
  return c.verdict_label;
}

/**
 * Records 6 and 7, judged PER FOOD HANDLER on the register (owner ruling Q18:
 * the key is the HRMS employee, else the login, else the name — a cook with no
 * login is on it). The authority asks for "every food handler", so a person on
 * the register with no certificate is named here: the old per-email reading
 * could only judge people who already had one.
 *   6 — medical fitness: every active food handler.
 *   7 — food-safety training (a FoSTaC certificate counts) for every active food
 *       handler, AND the FoSTaC line: at least one certified supervisor per
 *       FSSAI_FOSTAC_HANDLERS_PER_SUPERVISOR food handlers.
 * Coverage is readFssaiFoodHandlerCoverage() — the same function the Food
 * Handlers page shows — so the page and this record cannot disagree.
 */
function handlerRecord(ctx: Ctx, key: 'medical' | 'training'): Part {
  const p = blank();
  const isMed = key === 'medical';
  const what = isMed ? 'medical fitness certificate' : 'food-safety training record';
  const docTypes = isMed ? ['medical_fitness'] : ['food_handler_training', 'fostac_certificate'];
  p.links = [HANDLERS_LINK, DOCS_LINK, { href: '/fssai/hygiene', label: 'Personal Hygiene' }];
  const todo = isMed
    ? 'Open Food Handlers: put every food handler on the register (from HRMS, the logins, or by hand), then file each one\'s medical fitness certificate — with its expiry date and a scan — from their row.'
    : 'Open Food Handlers: file each food handler\'s food-safety training (FoSTaC or in-house, with a scan) from their row, and mark the FoSTaC-trained Food Safety Supervisor with their FoSTaC certificate.';
  p.basis =
    'From the food-handler register (Food Handlers). Every person marked a food handler who works here is judged on their own, ' +
    (isMed
      ? 'and needs a medical fitness certificate in force with a scan (one with no expiry date cannot be judged, so it is not in order). '
      : 'and needs food-safety training on file (a FoSTaC certificate counts; an in-house record need not expire). The FoSTaC supervisor needs a FoSTaC certificate in force: ' +
        'at least one certified supervisor for every 25 food handlers. ') +
    'PRESENT when every one is in order; EXPIRING when one falls inside its renewal window; MISSING when anyone has none, it has lapsed or no copy is attached — the record names them. ' +
    'Voided certificates and voided scans never count, nor does a superseded certificate once its renewal is in force (until then it is the one in force).';
  const miss = absent(ctx.present, ['fssai_documents', 'fssai_food_handlers']);
  if (miss.length) { p.problems = [NOT_IN_DB(miss)]; p.todo = todo; return p; }

  const cov: FssaiHandlerCoverage = readFssaiFoodHandlerCoverage(ctx.db, { today: ctx.today });
  const active = cov.handlers.filter((h) => h.status === 'active');
  const needed = active.filter((h) => h.coverage[key].required);
  const notIn = cov.not_in_order[key];
  const fostacBad = !isMed && !cov.fostac.ok;
  const expiring = needed.filter((h) => h.coverage[key].verdict === 'expiring');
  const supExpiring = isMed ? [] : active.filter((h) => h.coverage.fostac.required && h.coverage.fostac.verdict === 'expiring');

  let status: AuditFileStatus = 'present';
  const problems: string[] = [];
  if (!needed.length) {
    status = 'missing';
    problems.push(active.length
      ? `${plural(active.length, 'person', 'people')} on the register, but nobody is marked a food handler.`
      : 'Nobody is on the food-handler register yet, so there is nobody to judge — the authority asks for every food handler.');
  }
  if (notIn.length) {
    status = 'missing';
    problems.push(`No valid ${what}: ${notIn.map((x) => `${handlerName(x)} — ${x.verdict_label}${x.expiry_date ? ` ${x.expiry_date}` : ''}`).join('; ')}.`);
  }
  if (fostacBad) {
    status = 'missing';
    const supNotIn = cov.not_in_order.fostac;
    problems.push(`FoSTaC: ${cov.fostac.words}${supNotIn.length ? ` (${supNotIn.map((x) => `${handlerName(x)} — ${x.verdict_label}`).join('; ')})` : ''}`);
  }
  if (expiring.length || supExpiring.length) {
    status = worst(status, 'expiring');
    const list = [...expiring.map((h) => ({ h, c: h.coverage[key] })), ...supExpiring.map((h) => ({ h, c: h.coverage.fostac }))];
    problems.push(`Expiring soon: ${list.map(({ h, c }) => `${handlerName(h)} (${c.label}, ${c.best?.expiry_date || ''})`).join('; ')}. Renew before then.`);
  }

  // THE CERTIFICATES THEMSELVES, with whose they are — the copies an inspector
  // reads. A row with no live scan is a gap, so not in the handover. Read
  // FIRST: they carry the ONE per-person verdict (readDocs → ctx.paper →
  // fssaiPersonPapersInOrder), and the register, the "In order" count, the
  // FoSTaC box and "Next to lapse" below go into the inspector's copy only on
  // a paper these rows hand over — so the copy never names, counts or dates a
  // person whose certificate it holds back (a holder not in order).
  const docs = readDocs(ctx, docTypes);
  const holderOf = (d: DocRow) => d.holder || '(nobody named)';
  const certRows = docRows(docs, holderOf);
  /** 'document:<id>' | 'hrms:<id>' — every paper whose row goes into the inspector's copy. */
  const handedKeys = new Set<string>(docs.filter((d) => d.in_order).map((d) => `document:${d.id}`));
  // An HRMS training completion mapped on the Food Handlers page IS the record
  // of the training — there is no scan to lose. It goes into the inspector's
  // copy on the same rule as a filed certificate: only when the food-handler
  // record judges it in order (fssaiPersonPapersInOrder) — an EXPIRED one, or
  // an undated one counted as a FoSTaC certificate, never.
  if (!isMed) {
    const papers = fssaiPersonPapersInOrder(cov);
    for (const h of active) {
      for (const e of h.coverage.training.evidence.filter((x) => x.source === 'hrms')) {
        const v = papers.get(`hrms:${e.id}`);
        const ok = !!v?.in_order;
        if (ok) handedKeys.add(`hrms:${e.id}`);
        certRows.push(row([
          `${handlerName(h)} — ${e.title || e.type_label}`, 'HRMS', 'HRMS training record', e.issued_on, e.expiry_date || '—',
          ok ? STATE_WORDS[e.state] : (v?.words || STATE_WORDS[e.state]), 'HRMS record',
        ], HANDLERS_LINK.href, !ok ? 'bad' : e.state === 'expiring' ? 'warn' : '', ok));
      }
    }
  }
  type Req = FssaiFoodHandlerWithCoverage['coverage'][FssaiHandlerRequirementKey];
  /** The requirement rests on a paper the inspector's copy hands over. */
  const handed = (c: Req): boolean => c.in_order && !!c.best && handedKeys.has(`${c.best.source}:${c.best.id}`);
  /** The people this record's register lists: its food handlers, and (record 7) the FoSTaC supervisors. */
  const regPeople = active.filter((h) => h.coverage[key].required || (!isMed && h.coverage.fostac.required));
  /** Every certificate the register prints for this person is in the copy. */
  const personHanded = (h: FssaiFoodHandlerWithCoverage): boolean =>
    (!h.coverage[key].required || handed(h.coverage[key])) && (isMed || !h.coverage.fostac.required || handed(h.coverage.fostac));
  /**
   * In order for THIS record, but held back from the inspector's copy: the
   * person is not in order on another requirement (a holder not in order), or
   * the paper it rests on is the one another requirement of theirs fails.
   */
  const heldBack = regPeople.filter((h) => {
    const c = h.coverage[key];
    const f = h.coverage.fostac;
    return (c.required && c.in_order && !handed(c)) || (!isMed && f.required && f.in_order && !handed(f));
  });
  if (heldBack.length) {
    // The reason, for the page and the management copy (never the handover).
    problems.push(
      `Left out of the inspector's copy, because the person is not in order: ` +
      `${heldBack.map((h) => `${handlerName(h)} — ${h.problems.join(', ') || 'a certificate is not in order'}`).join('; ')}. ` +
      'The copy never names a person who is not in order.',
    );
  }

  const lapses = needed.map((h) => h.coverage[key]).filter((c) => c.in_order && c.best?.expiry_date).map((c) => c.best!.expiry_date);
  if (!isMed) for (const h of active) if (h.coverage.fostac.in_order && h.coverage.fostac.best?.expiry_date) lapses.push(h.coverage.fostac.best.expiry_date);
  // The handover's "Next to lapse" names a date on a certificate the copy
  // prints — only one these rows hand over, so a lapse date of anyone held
  // back is management's, like the person.
  const handedLapses = [
    ...needed.map((h) => h.coverage[key]).filter((c) => handed(c) && c.best?.expiry_date).map((c) => c.best!.expiry_date),
    ...(isMed ? [] : active.map((h) => h.coverage.fostac).filter((f) => f.required && handed(f) && f.best?.expiry_date).map((f) => f.best!.expiry_date)),
  ];
  const handedLapse = earliest(handedLapses);

  const inOrder = needed.filter((h) => h.coverage[key].in_order).length;
  /** "In order" as the inspector's copy can show it: a paper of theirs handed over. */
  const handedIn = needed.filter((h) => handed(h.coverage[key])).length;
  /** FoSTaC supervisors whose FoSTaC certificate the copy hands over. */
  const supHanded = isMed ? 0 : active.filter((h) => h.coverage.fostac.required && handed(h.coverage.fostac)).length;
  p.status = status;
  p.problems = problems;
  p.lapses_on = earliest(lapses);
  p.headline = needed.length
    ? `${plural(needed.length, 'food handler')} on the register · ${inOrder} with a ${isMed ? 'medical certificate' : 'training record'} in order` +
      (isMed ? '' : ` · FoSTaC: ${cov.fostac.certified} certified supervisor${cov.fostac.certified === 1 ? '' : 's'}, ${cov.fostac.required} needed`)
    : 'Nobody on the food-handler register';
  // A figure that only measures a gap is management's (mgmt: true) — "1 in
  // order" beside "3 food handlers" says two are not, on paper handed over.
  // So is the head-count itself while the roster is incomplete: "3 food
  // handlers" over the certificates of one says the other two have none.
  // Both are judged on the papers the copy hands over (handed), so a person
  // held back is never counted in it either.
  const gapIn = handedIn < needed.length;
  const complete = needed.length > 0 && !notIn.length && !fostacBad && regPeople.every(personHanded);
  p.summary = [
    complete ? { label: 'Food handlers', value: String(needed.length) } : { label: 'Food handlers', value: String(needed.length), mgmt: true as const },
    gapIn ? { label: 'In order', value: String(inOrder), mgmt: true as const } : { label: 'In order', value: String(handedIn) },
    { label: 'Not in order', value: String(notIn.length), mgmt: true },
    ...(heldBack.length ? [{ label: 'Held back', value: String(heldBack.length), mgmt: true as const }] : []),
    ...(isMed ? [] : [fostacBad
      ? { label: 'FoSTaC supervisors', value: `${cov.fostac.certified} of ${cov.fostac.required} needed`, mgmt: true as const }
      : supHanded >= cov.fostac.required
        ? { label: 'FoSTaC supervisors', value: `${supHanded} certified (${cov.fostac.required} needed)` }
        : { label: 'FoSTaC supervisors', value: `${cov.fostac.certified} certified (${cov.fostac.required} needed)`, mgmt: true as const }]),
    handedLapse
      ? { label: 'Next to lapse', value: handedLapse }
      : { label: 'Next to lapse', value: p.lapses_on || '—', mgmt: true as const },
    ...(handedLapse && p.lapses_on && p.lapses_on !== handedLapse
      ? [{ label: 'Next to lapse, any certificate', value: p.lapses_on, mgmt: true as const }]
      : []),
  ];

  // THE REGISTER, one line per person. It goes into the inspector's copy only
  // when EVERY person on it is in order AND has every certificate it prints
  // handed over (personHanded, the certificate rows' own verdict) — a partial
  // roster under the heading "food handlers" would read as the whole staff
  // (§7 Q11, and the owner's "never imply a complete file"), and a line for a
  // person whose certificate the copy holds back names who is not in order.
  const regRows = regPeople
    .map((h) => {
      const c = h.coverage[key];
      const f = h.coverage.fostac;
      const bad = (c.required && !c.in_order) || (!isMed && f.required && !f.in_order);
      const warn = c.verdict === 'expiring' || (!isMed && f.verdict === 'expiring');
      const certWords = c.best ? [c.best.type_label, c.best.reference_no ? `no. ${c.best.reference_no}` : ''].filter(Boolean).join(', ') : '';
      return row([
        handlerName(h), [h.designation, h.department_name].filter(Boolean).join(' · '),
        verdictCell(c), certWords,
        ...(isMed ? [] : [f.required ? verdictCell(f) : '—']),
      ], HANDLERS_LINK.href, bad ? 'bad' : warn ? 'warn' : '', complete);
    });

  p.tables = [
    table('Food handlers on the register', [
      { label: 'Food handler', width: 1.8 }, { label: 'Role', width: 1.3 },
      { label: isMed ? 'Medical fitness' : 'Food-safety training', width: 1.4 }, { label: 'Certificate', width: 1.7 },
      ...(isMed ? [] : [{ label: 'FoSTaC (supervisor)', width: 1.3 }]),
    ], regRows, ctx.limit, 'Nobody is on the food-handler register.'),
    table('Certificates on file', [{ label: 'Food handler — certificate', width: 2.6 }, ...DOC_COLUMNS.slice(1)], certRows, ctx.limit,
      'Nothing of this kind is on file.'),
  ];
  const stray = cov.unassigned_certificates.filter((u) => docTypes.includes(u.doc_type));
  if (stray.length) {
    p.tables.push(table('Certificates that match nobody on the register', [
      { label: 'Certificate', width: 2 }, { label: 'Filed against', width: 1.6 }, { label: 'Expires', width: 0.9 }, { label: 'Why it does not count', width: 3 },
    ], stray.map((u) => row([u.title || u.type_label, u.person_email || '—', u.expiry_date || '—', u.why], HANDLERS_LINK.href, 'warn', false)), ctx.limit));
  }
  p.scans = docs.flatMap((d) => d.scans.map((sc) => ({ ...sc, record_label: `${holderOf(d)} — ${sc.record_label}` })));
  if (p.status !== 'present') p.todo = todo;
  return p;
}

/* 8 ─ Approved vendor list */
function vendors(ctx: Ctx): Part {
  const p = blank();
  p.links = [{ href: '/vendors', label: 'Vendors — Approved vendor list' }, DOCS_LINK];
  p.basis =
    'From the approved-vendor register on Vendors. PRESENT when at least one supplier is marked approved and every approved supplier has an FSSAI licence in force on file with a copy attached; ' +
    'EXPIRING when an approved supplier\'s licence is inside its renewal window; MISSING when no supplier is approved, or an approved supplier\'s licence has expired, is not on file, or has no copy attached. ' +
    'The list goes into the inspector\'s copy only when every approved supplier on it is in order.';
  const todo =
    'On Vendors, open the Approved vendor list, mark each supplier you buy food from as approved (and what they supply), and file each one\'s FSSAI licence with a scan.';
  if (!vendorRegisterReady(ctx.db)) {
    p.problems = ['The approved-vendor register columns are not in this copy of the database yet. Restart the application once and they will be there.'];
    p.todo = todo;
    return p;
  }
  const approved = ctx.db.prepare(
    `SELECT id, name, fssai_supplies, fssai_approval_by, fssai_approval_at,
            (SELECT u.name FROM users u WHERE fssai_approval_by <> '' AND lower(u.email) = lower(fssai_approval_by) LIMIT 1) AS approver_name
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
  // A COPY IS THE RECORD (see the header). A supplier's FSSAI licence is a
  // document like the outlet's own — fssai_documents 'supplier_licence' with
  // its vendor_id, the register's own source (vendors/fssai-register.ts) — so
  // it is judged by the same paper rule as records 1–3 (judgeDocs): in force
  // WITH a live copy attached. A licence number typed in with no scan, or whose
  // only scan was voided, is the number, not the licence.
  const approvedIds = new Set(approved.map((v) => s(v.id)));
  const licDocs = ctx.present.has('fssai_documents')
    ? readDocs(ctx, ['supplier_licence']).filter((d) => approvedIds.has(d.vendor_id))
    : [];
  const docsByVendor = new Map<string, DocRow[]>();
  for (const d of licDocs) {
    if (!docsByVendor.has(d.vendor_id)) docsByVendor.set(d.vendor_id, []);
    docsByVendor.get(d.vendor_id)!.push(d);
  }

  const expired: string[] = [];
  const none: string[] = [];
  const noCopy: string[] = [];
  /** Approved, with no licence in force today, but one filed ahead of its valid-from date. */
  const notYet: string[] = [];
  const soon: string[] = [];
  const lapses: string[] = [];
  const judged = approved.map((v) => {
    const name = s(v.name);
    const list = docsByVendor.get(s(v.id)) || [];
    const j = list.length ? judgeDocs(list, 'FSSAI licence', ctx.today) : null;
    // The licence the row shows: the one judged best, else the latest on file.
    const shown: DocRow | null = j?.best || list[0] || null;
    if (!j || !shown) none.push(name);
    else if (j.status === 'missing' && list.every((d) => d.state === 'expired')) expired.push(`${name} (expired ${j.lapses_on || shown.expiry_date})`);
    else if (j.status === 'missing' && j.starts_on) {
      const next = list.find((d) => d.starts_on === j.starts_on) || shown;
      notYet.push(`${name} (${docLabel(next)}, in force only from ${j.starts_on}${j.lapses_on ? `; the one before expired on ${j.lapses_on}` : ''})`);
    } else if (j.status === 'missing') {
      noCopy.push(`${name} (${docLabel(shown)}${shown.voided ? ' — its only scan was voided' : ''})`);
    } else if (j.status === 'expiring') { soon.push(`${name} (expires ${shown.expiry_date})`); lapses.push(shown.expiry_date); }
    else if (shown.expiry_date) lapses.push(shown.expiry_date);
    return { v, name, list, shown, ok: !!j && j.status !== 'missing', expiring: j?.status === 'expiring' };
  });

  const problems: string[] = [];
  let status: AuditFileStatus = 'present';
  if (!approved.length) {
    status = 'missing';
    problems.push(`No supplier is marked approved yet (${plural(intOr(totals?.unreviewed), 'supplier')} not reviewed).`);
  }
  if (expired.length) { status = 'missing'; problems.push(`Approved, but their FSSAI licence has expired: ${expired.join(', ')}.`); }
  if (none.length) { status = 'missing'; problems.push(`Approved, but no FSSAI licence is on file: ${none.join(', ')}.`); }
  if (noCopy.length) { status = 'missing'; problems.push(`Approved, but no copy of their FSSAI licence is attached — the file has the number, not the licence: ${noCopy.join(', ')}.`); }
  if (notYet.length) { status = 'missing'; problems.push(`Approved, but no FSSAI licence of theirs is in force today — the one on file is not yet in force: ${notYet.join(', ')}.`); }
  if (soon.length) { status = worst(status, 'expiring'); problems.push(`Licence expiring soon: ${soon.join(', ')}.`); }

  // THE LIST goes into the inspector's copy only when EVERY approved supplier
  // on it holds a licence in force with its copy — the same rule as the
  // food-handler roster (records 6, 7): a list with suppliers cut out would
  // read as the whole list, and a line reading EXPIRED or "Not on file" is a
  // sentence about a gap (§7 Q11). The page and the management copy show all.
  const complete = approved.length > 0 && judged.every((x) => x.ok);
  const rows = judged.map(({ v, name, shown, ok, expiring }) => row([
    // WHO APPROVED, by NAME — the inspector's copy goes to an outside authority,
    // and a login email is not something to hand over. A login with no name on
    // its user row reads "a manager"; a value that is not a login prints as typed.
    name, s(v.fssai_supplies), [
      s(v.approver_name) || personWords(ctx.db, v.fssai_approval_by),
      s(v.fssai_approval_at).slice(0, 10),
    ].filter(Boolean).join(' · '),
    shown?.reference_no || '—', shown?.expiry_date || '—',
    // A licence filed ahead of its valid-from date says so ("Not yet in force (from …)").
    shown ? (shown.starts_on ? shown.state_words : STATE_WORDS[shown.state]) : 'Not on file',
    !shown ? '—' : shown.stored ? plural(shown.stored, 'scan') : shown.voided ? 'voided only' : 'none',
  ], '/vendors', !ok ? 'bad' : expiring ? 'warn' : '', complete));

  p.status = status;
  p.problems = problems;
  p.lapses_on = earliest(lapses);
  p.headline = approved.length
    ? `${plural(approved.length, 'approved supplier')} · ${judged.filter((x) => x.ok).length} with a licence in force and its copy on file`
    : 'No supplier approved yet';
  p.summary = [
    { label: 'Approved', value: String(approved.length) },
    { label: 'Not approved', value: String(intOr(totals?.refused)), mgmt: true },
    { label: 'Not reviewed', value: String(intOr(totals?.unreviewed)), mgmt: true },
  ];
  p.tables = [table('Approved suppliers', [
    { label: 'Supplier', width: 2 }, { label: 'Approved to supply', width: 1.9 }, { label: 'Approved by', width: 1.6 },
    { label: 'FSSAI licence', width: 1.4 }, { label: 'Expires', width: 0.9 }, { label: 'Licence', width: 0.9 }, { label: 'Copy', width: 0.7 },
  ], rows, ctx.limit, 'No supplier is marked approved.')];
  // The suppliers' licence copies, under whose they are. In the inspector's
  // copy only with the complete list (and never the scan of an expired one).
  p.scans = judged.flatMap(({ name, list }) => list.flatMap((d) => d.scans.map((sc) => ({
    ...sc, record_label: `${name} — ${sc.record_label}`, in_handover: complete && sc.in_handover,
  }))));
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
    intOr(r.line_count), intOr(r.fail_count), intOr(r.rejected_count), personWords(ctx.db, r.checked_name || r.checked_by),
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

/**
 * "≤ 37.5 C by then" — where a cooling or reheating reading had to be at its
 * minute, from the reading's own FROZEN line (fssaiReadingScheduleValue). ''
 * for any other reading, or a line that cannot be drawn.
 */
function scheduleWords(r: any): string {
  const v = fssaiReadingScheduleValue(r);
  if (v === null || !Number.isFinite(v)) return '';
  const hot = s(r.log_kind) === 'reheating' || s(r.log_kind) === 'hot_holding';
  return `${hot ? '>=' : '<='} ${Number(v).toFixed(1)} ${s(r.uom)} by then`.trim();
}

/**
 * Records 10 and 11. `kinds` are the readings LISTED; `judgedKinds` the ones
 * whose last entry decides the status. For record 11 ("Cooking/reheating
 * temperature log") that is cooking and reheating ONLY: a cooling or
 * hot-holding reading is a real record and is printed with it, but a kitchen
 * that logged only cooling has no cooking/reheating log, and the record says
 * so instead of turning PRESENT.
 *
 * Every verdict word and minutes cell comes from _p4/lib — the words Reports
 * prints — so a pot still on its way down reads "On schedule", never "In
 * range" of a 5 °C rule, and a reading at minute 0 reads "0 of 240".
 */
function tempLog(
  ctx: Ctx, key: 'cold_temps' | 'cooking_temps', kinds: string[], judgedKinds: string[],
  what: string, todo: string, links: AuditFileLink[],
): Part {
  const p = blank();
  const cadence = CADENCE[key];
  p.links = links;
  const others = kinds.filter((k) => !judgedKinds.includes(k));
  p.basis = logBasis(cadence) +
    (key === 'cold_temps'
      ? ' A unit read in this period that has gone quiet for longer than that makes it EXPIRING too. Only per-unit readings under Temperature Logs count: ' +
        'the cold-store checklist\'s single "reading seen on this round" is a spot check of the round, not this log.'
      : '') +
    (others.length
      ? ` Only ${judgedKinds.map((k) => fssaiTempLogKindLabel(k).toLowerCase()).join(' and ')} readings decide it; ` +
        `${others.map((k) => fssaiTempLogKindLabel(k).toLowerCase()).join(' and ')} readings are listed with it but never make it PRESENT. ` +
        'A cooling or reheating reading is judged against its batch\'s schedule: one that is where the schedule allows reads "On schedule".'
      : '');
  const miss = absent(ctx.present, ['fssai_temperature_logs']);
  if (miss.length) { p.problems = [NOT_IN_DB(miss)]; p.todo = todo; return p; }

  const marks = (list: string[]) => list.map(() => '?').join(',');
  const latest = s((ctx.db.prepare(
    `SELECT MAX(business_date) AS d FROM fssai_temperature_logs t WHERE t.log_kind IN (${marks(judgedKinds)}) AND ${LIVE('t')}`,
  ).get(...judgedKinds) as any)?.d);
  const hasCurveCols = !!ctx.db.prepare(`SELECT 1 FROM pragma_table_xinfo('fssai_temperature_logs') WHERE name = 'curve_start_source'`).get();
  const rows = ctx.db.prepare(
    `SELECT id, business_date, reading_at, log_kind, equipment_label, area_label, item_label, value_num, uom, decimals,
            min_used, max_used, target_used, is_fail, is_judged, action_taken, recorded_name, recorded_by,
            elapsed_minutes, max_minutes_used
            ${hasCurveCols ? ', curve_start_used, curve_start_minute, curve_start_source' : ''}
       FROM fssai_temperature_logs t
      WHERE t.log_kind IN (${marks(kinds)}) AND ${LIVE('t')} AND business_date >= ? AND business_date <= ?
      ORDER BY business_date DESC, reading_at DESC`,
  ).all(...kinds, ctx.since, ctx.today) as any[];
  const judgedRows = rows.filter((r) => judgedKinds.includes(s(r.log_kind)));

  const v = judgeLog(latest, ctx.today, cadence, what);
  let status = v.status;
  const problems = [...v.problems];
  if (!latest && rows.length) {
    const seen = [...new Set(rows.map((r) => fssaiTempLogKindLabel(r.log_kind).toLowerCase()))];
    problems.push(`${plural(rows.length, 'reading')} since ${ctx.since}, all ${seen.join(' / ')} — none is a ${judgedKinds.map((k) => fssaiTempLogKindLabel(k).toLowerCase()).join(' or ')} reading, which is what this log is.`);
  }
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
  if (unactioned.length) problems.push(`${plural(unactioned.length, 'failed reading')} in this period ${unactioned.length === 1 ? 'has' : 'have'} no action written against ${unactioned.length === 1 ? 'it' : 'them'}.`);

  p.status = status;
  p.problems = problems;
  p.headline = latest
    ? `${plural(judgedRows.length, `${judgedKinds.map((k) => fssaiTempLogKindLabel(k).toLowerCase()).join('/')} reading`)} since ${ctx.since} · last on ${latest}` +
      (others.length && rows.length > judgedRows.length ? ` · ${rows.length - judgedRows.length} ${others.map((k) => fssaiTempLogKindLabel(k).toLowerCase()).join('/')} listed with it` : '')
    : rows.length ? `No ${what} recorded · ${plural(rows.length, 'other reading')} listed` : `No ${what} recorded`;
  p.summary = [
    { label: others.length ? 'Cooking/reheating readings' : 'Readings', value: String(judgedRows.length) },
    ...(others.length ? [{ label: 'Cooling/hot-holding listed', value: String(rows.length - judgedRows.length) }] : []),
    { label: 'Failed', value: String(fails.length) },
    { label: 'Not judged', value: String(rows.filter((r) => intOr(r.is_judged, 1) === 0).length), mgmt: true },
    { label: 'Last reading', value: latest || '—' },
  ];
  const isCold = key === 'cold_temps';
  p.tables = [table(`Readings from ${ctx.since}`, [
    { label: 'Date', width: 1.05 }, { label: 'Time', width: 0.6 },
    { label: isCold ? 'Unit' : 'What', width: isCold ? 1.7 : 1.5 }, { label: isCold ? 'Area' : 'Kind', width: 0.9 },
    ...(isCold ? [] : [{ label: 'Minutes', width: 0.8 }]),
    { label: 'Reading', width: 0.8, align: 'right' as const }, { label: 'Range applied', width: isCold ? 1.15 : 1.5 }, { label: 'Verdict', width: 1.05 },
    { label: 'Action taken', width: 1.4 }, { label: 'By', width: 1 },
  ], rows.map((r) => {
    const reading = numOrBlank(r.value_num, intOr(r.decimals, 1));
    const range = [rangeWords(r.min_used, r.max_used, s(r.uom)), scheduleWords(r)].filter(Boolean).join('; ');
    return row([
      s(r.business_date), s(r.reading_at).slice(11, 16) || s(r.reading_at).slice(0, 5),
      isCold ? s(r.equipment_label || r.area_label) : [s(r.item_label), s(r.equipment_label || r.area_label)].filter(Boolean).join(' · '),
      isCold ? s(r.area_label) : fssaiTempLogKindLabel(r.log_kind),
      ...(isCold ? [] : [fssaiTempMinutesWords(r)]),
      reading ? `${reading} ${s(r.uom)}`.trim() : '—', range, fssaiTempVerdictWord(r),
      s(r.action_taken), personWords(ctx.db, r.recorded_name || r.recorded_by),
    ], '/fssai/temperature', intOr(r.is_fail) ? 'bad' : '',
    // A cooling or hot-holding reading goes into the inspector's copy only
    // beside at least one reading of the log itself: alone, it would put
    // "Cooking/reheating temperature log" in the copy with no such reading.
    judgedKinds.includes(s(r.log_kind)) || judgedRows.length > 0);
  }), ctx.limit)];
  if (p.status !== 'present') p.todo = todo;
  return p;
}

/* 12, 13, 18 ─ checklist rounds */
function runsOf(ctx: Ctx, where: string, args: any[]): { latest: string; rows: any[] } {
  const latest = s((ctx.db.prepare(
    `SELECT MAX(r.business_date) AS d FROM fssai_runs r JOIN fssai_templates t ON t.id = r.template_id
      WHERE r.status IN ('submitted','verified') AND r.voided_at = '' AND (${where}) AND ${ctx.notHydAudit}`,
  ).get(...args) as any)?.d);
  const rows = ctx.db.prepare(
    `SELECT r.id, r.business_date, r.shift, r.target_label, r.status, r.outcome, r.answered_count, r.total_count,
            r.fail_count, r.recorded_name, r.recorded_by, r.signed_by, t.name AS template_name, t.code AS template_code
       FROM fssai_runs r JOIN fssai_templates t ON t.id = r.template_id
      WHERE r.status IN ('submitted','verified') AND r.voided_at = '' AND (${where}) AND ${ctx.notHydAudit}
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
    `SELECT COUNT(*) AS n FROM fssai_templates t WHERE t.is_active = 1 AND t.status = 'published' AND (${where}) AND ${ctx.notHydAudit}`,
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

/** A template with a Pests section — the daily pest LOOK on the kitchen round. */
const PEST_TEMPLATE_WHERE =
  `EXISTS (SELECT 1 FROM fssai_sections sx WHERE sx.template_id = t.id AND sx.is_active = 1
            AND (sx.code = 'PEST' OR lower(sx.title) LIKE '%pest%'))`;

/**
 * 13 — PEST-CONTROL MONITORING SHEET. The authority's sheet is one line per
 * station per check: date, device, activity yes/no, action, initials. That is
 * fssai_pest_device_checks, read through the pest lane's own reader
 * (readPestMonitoringSheet) — its verdict decides this record:
 *   missing  — no station on the pest map, or none checked in these dates
 *   expiring — a station in use is overdue or was never checked (or a pest
 *              sighting in these dates is still open)
 *   present  — stations checked, every one inside its own frequency.
 * A checklist round is NEVER the monitoring sheet: the daily kitchen round's
 * Pests section is a look, listed beside it; the authority's monthly Checklist
 * 3 is a self-audit and is not even listed here (ctx.notHydAudit).
 * Voided check lines stay on the sheet, marked VOID with the reason.
 */
function pestMonitoring(ctx: Ctx): Part {
  const p = blank();
  p.links = [{ href: '/fssai/pest-control', label: 'Pest Control Logs — Station checks' }, { href: '/fssai/cleaning', label: 'Cleaning & Sanitation' }];
  p.basis =
    'The station-by-station monitoring sheet (Pest Control Logs → Station checks): one line per bait station, glue board or insect-light trap ' +
    'at every check — date, device, activity yes or no, action taken, initials. PRESENT when stations were checked in these dates and every ' +
    'station in use is inside its own check frequency; EXPIRING when a station is overdue or has never been checked, or a pest sighting in ' +
    'these dates is still open; MISSING when no station is on the pest map or none was checked in these dates. A checklist round is not the ' +
    'monitoring sheet: the daily pest look on the kitchen round is listed beside it, and the authority\'s monthly self-audit pages never count.';
  const todo =
    'Put every bait station, glue board and insect-light trap on the pest map (Pest Control Logs → Monitoring points), then walk them on the ' +
    'Station checks tab — every station on its own schedule, activity yes or no, the action and your initials.';
  const miss = absent(ctx.present, ['fssai_pest_device_checks', 'fssai_pest_devices']);
  if (miss.length) { p.problems = [NOT_IN_DB(miss)]; p.todo = todo; return p; }

  const sheet = readPestMonitoringSheet(ctx.db, { from: ctx.since, to: ctx.today, today: ctx.today });
  p.status = sheet.verdict;
  // The sheet's own sentences, minus the one that only says where activity was
  // filed (it is not a gap: activity found and acted on IS the record working).
  p.problems = sheet.problems.filter((x) => !/^Activity was found/.test(x));
  const dues = sheet.stations.map((st) => st.due_on).filter((d) => isISODate(d));
  p.lapses_on = earliest(dues);
  const live = sheet.rows.filter((r) => !r.is_void);
  p.headline = live.length
    ? `${plural(live.length, 'station check')} in ${plural(sheet.totals.rounds, 'round')} since ${ctx.since} · last on ${sheet.last_check_date} · ${plural(sheet.totals.stations_in_use, 'station')} on the map`
    : sheet.totals.stations_in_use ? `${plural(sheet.totals.stations_in_use, 'station')} on the map, none checked since ${ctx.since}` : 'No station on the pest map';
  p.summary = [
    { label: 'Rounds', value: String(sheet.totals.rounds) },
    { label: 'Station checks', value: String(sheet.totals.lines) },
    { label: 'Activity found', value: String(sheet.totals.activity) },
    // The station count beside a sheet with a station missing from it measures
    // the gap, so it is management's then.
    sheet.totals.stations_overdue + sheet.totals.stations_never
      ? { label: 'Stations', value: String(sheet.totals.stations_in_use), mgmt: true as const }
      : { label: 'Stations', value: String(sheet.totals.stations_in_use) },
    { label: 'Overdue or never checked', value: String(sheet.totals.stations_overdue + sheet.totals.stations_never), mgmt: true },
  ];

  // THE SHEET — newest first, like every other log here. A voided line stays,
  // marked VOID with its reason (void, never delete).
  const lines = [...sheet.rows].reverse();
  p.tables.push(table(`Station checks from ${ctx.since}`, [
    { label: 'Date', width: 0.9 }, { label: 'Time', width: 0.5 }, { label: 'Station', width: 0.7 }, { label: 'Kind · where', width: 1.8 },
    { label: 'Activity', width: 0.6 }, { label: 'Pest', width: 0.8 }, { label: 'Device', width: 0.8 },
    { label: 'Action taken', width: 1.9 }, { label: 'Initials', width: 0.6 },
  ], lines.map((r) => row([
    r.business_date, r.checked_at, r.device_code, [r.device_kind_label, r.location_label].filter(Boolean).join(' · '),
    r.activity_label, r.activity_kind_label, r.device_condition_label,
    r.is_void ? `VOID — ${r.void_reason || 'voided'}${r.voided_by ? ` (${r.voided_by})` : ''}` : r.action_taken,
    r.initials,
  ], '/fssai/pest-control', r.is_void ? 'void' : r.is_fail ? 'bad' : '')), ctx.limit, 'No station was checked in these dates.'));

  // THE STATIONS — in the inspector's copy only when every one is inside its
  // schedule: a station list with gaps cut out would read as the whole map.
  const allOk = sheet.stations.length > 0 && sheet.stations.every((st) => st.state === 'ok' || st.state === 'due');
  p.tables.push(table('Stations on the pest map', [
    { label: 'Code', width: 0.7 }, { label: 'Kind', width: 1.1 }, { label: 'Location', width: 2 }, { label: 'Checked', width: 0.9 },
    { label: 'Last check', width: 1.1 }, { label: 'Next due', width: 0.9 }, { label: 'State', width: 0.9 },
  ], sheet.stations.map((st) => row([
    st.code, st.device_kind_label, st.location_label, st.check_frequency + (st.frequency_assumed ? ' (assumed)' : ''),
    [st.last_check_date, st.last_check_time].filter(Boolean).join(' ') || '—', st.due_on || '—', st.state_label,
  ], '/fssai/pest-control', st.state === 'overdue' || st.state === 'never' ? 'bad' : st.state === 'due' ? 'warn' : '', allOk)), ctx.limit,
  'No station is on the pest map.'));

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

  // THE DAILY PEST LOOK — listed, never deciding (see the header).
  if (absent(ctx.present, ['fssai_runs', 'fssai_templates', 'fssai_sections']).length === 0) {
    const { rows } = runsOf(ctx, PEST_TEMPLATE_WHERE, []);
    if (rows.length) {
      p.summary.push({ label: 'Daily pest looks', value: String(rows.length) });
      p.tables.push(table(`Daily pest look on the kitchen round, from ${ctx.since}`, RUN_COLUMNS, runRows(rows), ctx.limit));
    }
  }

  // Sightings and the daily look are not the sheet: with no station check in
  // these dates they stay out of the inspector's copy, so the copy never holds
  // a "Pest-control monitoring sheet" that is not one.
  if (!live.length) {
    for (const t of p.tables) {
      for (const r of t.rows) r.in_handover = false;
      t.handover_rows = 0;
    }
  }

  if (p.status !== 'present') {
    p.todo = sheet.verdict !== 'present' ? todo : 'Close each open sighting on Pest Control Logs with what was done about it.';
  }
  return p;
}

function fifo(ctx: Ctx): Part {
  const p = checklistRecord(ctx, 'fifo', `t.module_key = ?`, ['storage'], 'storage round',
    'Run the storage checklists on Food Storage Checks — the daily dry-store and cold-store rounds (oldest stock to the front, FEFO) and the weekly rotation round.',
    [{ href: '/fssai/storage', label: 'Food Storage Checks' }, { href: '/fssai/fifo', label: 'FIFO & Expiry Management' }],
    'No storage checklist is published. An administrator publishes the ready-made ones under FSSAI Settings.');
  p.basis = 'FIFO and FEFO are asked on the storage rounds (dry store, cold store, weekly rotation). ' + p.basis +
    ' The expiry register is listed beside the rounds; it never decides, and without a round it is not handed over.';
  /** The storage rounds — the checklist itself (undefined when its tables are absent). */
  const roundTable: AuditFileTable | undefined = p.tables[0];
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
    // The expiry register is listed BESIDE the rounds and never decides. With
    // no storage round in these dates it stays out of the inspector's copy, so
    // "18. FIFO/FEFO checklist" is never handed over holding no checklist.
    if (!(roundTable?.handover_rows)) keepOutOfHandover(p.tables.filter((t) => t !== roundTable));
  }
  return p;
}

/* 14 ─ Waste disposal record */
/**
 * The HANDOVER LOG decides it (wasteHandoverAuditPart, the waste lane's own
 * reader, judged on the last live handover against WASTE_HANDOVER_CADENCE):
 * one line per handover — date, wet / dry / other, quantity, collector, receipt
 * or vehicle, who handed it over — is what the authority asks to see. The
 * collector's agreement (a document) is listed BESIDE it with its copy, and so
 * are expired stock discarded and used oil handed over; none of them decides.
 */
function waste(ctx: Ctx): Part {
  const part = wasteHandoverAuditPart(ctx.db, { today: ctx.today, since: ctx.since, rowLimit: ctx.limit });
  const p: Part = {
    ...blank(),
    status: part.status,
    headline: part.headline,
    problems: [...part.problems],
    todo: part.todo,
    lapses_on: part.lapses_on,
    basis: part.basis + ' The collector\'s agreement or receipts (Documents & Certificates, "Waste disposal record"), expired stock discarded and used oil handed over are listed beside it; they do not decide it, and with no handover in these dates they are not handed over.',
    links: [...part.links, DOCS_LINK, { href: '/fssai/fifo', label: 'FIFO & Expiry Management' }, { href: '/fssai/oil-quality', label: 'Oil Quality Checks' }],
    summary: part.summary.map((x) => ({ ...x })),
    tables: part.tables.map((t) => ({ ...t, rows: t.rows.map((r) => ({ ...r })) })),
    // The lane lists ACTIVE photos on live handovers only; shaped here so the
    // one partition in buildAuditFile sees the same fields as every record.
    scans: part.scans.map((sc) => shapeScan({ ...sc, id: sc.attachment_id, status: 'active' }, sc.record_label)),
  };
  /** The handover log's own table(s), and how many of its lines the handover may carry. */
  const logTables = [...p.tables];
  const logRows = logTables.reduce((a, t) => a + t.handover_rows, 0);

  if (ctx.present.has('fssai_documents')) {
    const docs = readDocs(ctx, ['waste_disposal_record']);
    // One filed ahead of its valid-from date is not in force yet: never "the" agreement today.
    const usable = docs.filter((d) => d.stored > 0 && !d.starts_on)
      .map((d) => ({ d, end: d.until })).filter((x) => x.end)
      .sort((a, b) => (a.end < b.end ? 1 : -1));
    const pendingAgreement = docs.find((d) => d.stored > 0 && d.starts_on);
    // An agreement that has run out is a sentence about a lapse: management's.
    p.summary.push(usable[0]?.d.in_order
      ? { label: 'Agreement', value: `until ${usable[0].end}` }
      : {
        label: 'Agreement',
        value: usable[0] ? `ran out ${usable[0].end}` : pendingAgreement ? fssaiNotYetWords(pendingAgreement.starts_on).toLowerCase() : '—',
        mgmt: true as const,
      });
    p.tables.push(table('The collector\'s agreement and receipts', DOC_COLUMNS, docRows(docs), ctx.limit, 'Nothing of this kind is on file.'));
    p.scans.push(...docs.flatMap((d) => d.scans));
  }
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
  // The agreement, the discarded stock and the used oil are listed BESIDE the
  // log and never decide. With no handover of the log itself in these dates
  // they stay out of the inspector's copy (and so do the agreement's scans):
  // "14. Waste disposal record" is never handed over holding no waste record.
  if (!logRows) keepOutOfHandover(p.tables.filter((t) => !logTables.includes(t)), p.scans.filter((sc) => sc.entity_table !== 'fssai_waste_handovers'));
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
    personWords(ctx.db, r.recorded_name || r.recorded_by),
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
/**
 * What IS maintenance — a service or repair, a deep clean, a defrost, a filter
 * change (FSSAI_EQUIPMENT_EVENT_KINDS). Only these decide the record and set a
 * unit's next-service date.
 */
const MAINTENANCE_KINDS = ['repair', 'cleaning', 'defrost', 'filter_change'];
/**
 * What happened TO a unit that is not maintenance: it broke down, was taken
 * out of use, came back. A unit failing is not a maintenance record, so these
 * are LISTED beside the maintenance (the inspector asks about them when a
 * reading is out of range) and never make the record PRESENT. Without a
 * maintenance entry or an AMC in force they stay out of the inspector's copy.
 */
const UNIT_INCIDENT_KINDS = ['breakdown', 'out_of_service', 'back_in_service'];

function maintenance(ctx: Ctx): Part {
  const p = blank();
  p.links = [{ href: '/fssai/cold-rooms', label: 'Cold Room Climate Control' }, DOCS_LINK];
  p.basis =
    `PRESENT when a service, repair, defrost, deep clean or filter change was recorded in the last ${CURRENCY_DAYS.maintenance} days, or a service contract (AMC) is in force with a copy. ` +
    `MISSING when neither, or when a unit's own next-service date has passed. EXPIRING when a next-service date or the AMC falls within ${WARN_DAYS} days. ` +
    'A breakdown, or a unit taken out of use or put back, is listed with it but is not maintenance and never makes it PRESENT.';
  const todo =
    'Record each service, repair and deep clean against the unit under Cold Room Climate Control (with the next due date), and file any AMC under Documents & Certificates.';
  const miss = absent(ctx.present, ['fssai_equipment_events', 'fssai_documents']);
  if (miss.length) { p.problems = [NOT_IN_DB(miss)]; p.todo = todo; return p; }

  const kinds = [...MAINTENANCE_KINDS, ...UNIT_INCIDENT_KINDS];
  const marks = kinds.map(() => '?').join(',');
  const all = ctx.db.prepare(
    `SELECT id, equipment_id, equipment_label, event_kind, business_date, detail, performed_by, reference_no, next_due_date
       FROM fssai_equipment_events ev
      WHERE ev.event_kind IN (${marks}) AND ev.voided_at = '' AND ev.status <> 'void'
      ORDER BY business_date DESC, created_at DESC`,
  ).all(...kinds) as any[];
  const isMaint = (e: any) => MAINTENANCE_KINDS.includes(s(e.event_kind));
  /** Maintenance only — what decides the record. */
  const events = all.filter(isMaint);
  const amc = readDocs(ctx, ['amc']);
  const amcV = judgeDocs(amc, 'service contract (AMC)', ctx.today);

  const recentCut = addDaysISO(ctx.today, -CURRENCY_DAYS.maintenance);
  const recent = events.filter((e) => s(e.business_date) >= recentCut);
  const incidentsRecent = all.filter((e) => !isMaint(e) && s(e.business_date) >= recentCut);
  const problems: string[] = [];
  let status: AuditFileStatus = recent.length || amcV.status !== 'missing' ? 'present' : 'missing';
  if (status === 'missing') {
    problems.push(events.length
      ? `No maintenance recorded in the last ${CURRENCY_DAYS.maintenance} days — the last was on ${s(events[0].business_date)}, and no service contract is in force.`
      : 'No maintenance has been recorded for any unit, and no service contract (AMC) is on file.');
    if (incidentsRecent.length) {
      problems.push(`${plural(incidentsRecent.length, 'breakdown or out-of-use entry', 'breakdown or out-of-use entries')} in that time ${incidentsRecent.length === 1 ? 'is' : 'are'} listed, but a unit failing is not maintenance — record the repair or service that followed.`);
    }
  }
  if (amcV.status === 'expiring') { status = worst(status, 'expiring'); problems.push(...amcV.problems); }

  // Each unit's LATEST MAINTENANCE entry sets its next-service date; an older
  // one is history. A breakdown after a service never hides that service's
  // next-due date (it carries none of its own).
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

  const from = periodicFrom(ctx);
  const inWindow = all.filter((e) => s(e.business_date) >= from);
  const maintInWindow = inWindow.filter(isMaint);
  const incidentsInWindow = inWindow.length - maintInWindow.length;
  // A breakdown / out-of-use line goes into the inspector's copy only BESIDE
  // maintenance on file (an entry in these dates, or an AMC in force with its
  // copy) — alone it would put "16. Equipment maintenance records" in the copy
  // with no maintenance record in it.
  const incidentsHanded = maintInWindow.length > 0 || amcV.status !== 'missing';

  p.status = status;
  p.problems = problems;
  p.lapses_on = earliest(lapses);
  p.headline = events.length
    ? `${plural(recent.length, 'maintenance entry', 'maintenance entries')} in the last ${CURRENCY_DAYS.maintenance} days · last on ${s(events[0].business_date)}` +
      (incidentsInWindow ? ` · ${plural(incidentsInWindow, 'breakdown or out-of-use entry', 'breakdown or out-of-use entries')} listed with it` : '')
    : amcV.best ? `AMC ${docLabel(amcV.best)}` + (incidentsInWindow ? ` · ${plural(incidentsInWindow, 'breakdown or out-of-use entry', 'breakdown or out-of-use entries')} listed` : '')
      : incidentsInWindow ? `No maintenance recorded · ${plural(incidentsInWindow, 'breakdown or out-of-use entry', 'breakdown or out-of-use entries')} listed` : 'Nothing recorded';
  p.summary = [
    { label: 'Entries (92 days)', value: String(recent.length) },
    { label: 'Units', value: String(latestByUnit.size) },
    // The AMC box names a contract the copy prints (in order, its copy on
    // file); "AMC —", or the date of one withheld, is management's — as the
    // pest record's Agreement box.
    { label: 'AMC', value: amcV.best ? (amcV.best.expiry_date || 'no expiry') : '—', ...(amcV.best?.in_order ? {} : { mgmt: true as const }) },
    ...(incidentsInWindow ? [{ label: 'Breakdowns / out of use', value: String(incidentsInWindow) }] : []),
  ];
  p.tables = [
    table(`Maintenance from ${from}`, [
      { label: 'Date', width: 0.9 }, { label: 'Unit', width: 1.5 }, { label: 'What', width: 1.1 }, { label: 'Detail', width: 2.2 },
      { label: 'Done by', width: 1.2 }, { label: 'Ref.', width: 0.8 }, { label: 'Next due', width: 0.9 },
    ], inWindow.map((e) => row([
      s(e.business_date), s(e.equipment_label), s(e.event_kind).replace(/_/g, ' '), s(e.detail), s(e.performed_by), s(e.reference_no), dueCell(e.next_due_date, ctx.today),
    ], '/fssai/cold-rooms', s(e.event_kind) === 'breakdown' ? 'bad' : '', isMaint(e) || incidentsHanded)), ctx.limit),
    table('Service contracts (AMC)', DOC_COLUMNS, docRows(amc), ctx.limit, 'No service contract is on file.'),
  ];
  const eventScans = readScans(ctx.db, 'fssai_equipment_events', inWindow.slice(0, 6).map((e) => s(e.id)),
    (id) => { const e = all.find((x) => s(x.id) === id); return e ? `${s(e.equipment_label)} — ${s(e.event_kind).replace(/_/g, ' ')} (${s(e.business_date)})` : 'Maintenance'; });
  for (const sc of eventScans) {
    const e = all.find((x) => s(x.id) === sc.entity_id);
    if (e && !isMaint(e) && !incidentsHanded) sc.in_handover = false;
  }
  p.scans = [...amc.flatMap((d) => d.scans), ...eventScans];
  if (p.status !== 'present') p.todo = todo;
  return p;
}

/* 17 ─ Calibration certificates */
function calibration(ctx: Ctx): Part {
  const p = blank();
  p.links = [DOCS_LINK, { href: '/fssai/cold-rooms', label: 'Cold Room Climate Control' }];
  p.basis =
    "From Documents & Certificates (\"Calibration certificate\", filed against the instrument). Each instrument's latest certificate is judged on its own; " +
    'in force with a copy → PRESENT, inside its renewal window → EXPIRING, expired or no copy → MISSING. In-house probe checks are listed alongside; ' +
    'they are not certificates, never decide it, and without a certificate in force they are not handed over.';
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
  // THE HANDOVER'S FIGURES COUNT WHAT IT PRINTS (as the ON FILE box of
  // paperRecord and foodLab). "Instruments 2" over a table of one certificate,
  // or "Next to lapse" naming the date a withheld, expired certificate ran out,
  // is a sentence about a gap (§7 Q11): those are management's (mgmt).
  const handedGroups = [...groups.values()].filter((list) => list.some((d) => d.in_order));
  const handedLapse = earliest(handedGroups.map((list) => {
    const v = judgeDocs(list.filter((d) => d.in_order), 'calibration certificate', ctx.today);
    return v.lapses_on;
  }).filter((x) => isISODate(x) && x >= ctx.today));
  p.summary = [
    handedGroups.length
      ? { label: 'Instruments', value: String(handedGroups.length) }
      : { label: 'Instruments', value: String(groups.size), mgmt: true as const },
    ...(handedGroups.length && handedGroups.length !== groups.size
      ? [{ label: 'Without a certificate in force', value: String(groups.size - handedGroups.length), mgmt: true as const }]
      : []),
    handedLapse
      ? { label: 'Next to lapse', value: handedLapse }
      : { label: 'Next to lapse', value: p.lapses_on || '—', mgmt: true as const },
    ...(handedLapse && p.lapses_on && p.lapses_on !== handedLapse
      ? [{ label: 'Earliest lapse, any certificate', value: p.lapses_on, mgmt: true as const }]
      : []),
  ];
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
  // The in-house probe checks are listed BESIDE the certificates and never
  // decide. Without a certificate the inspector's copy can carry, they stay out
  // of it: "17. Calibration certificates" is never handed over holding none.
  const certHanded = p.tables.some((t) => t.handover_rows > 0) || p.scans.some((sc) => isLiveCopy(sc) && sc.in_handover);
  if (!certHanded) for (const r of inHouse) r.in_handover = false;
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
  // d.until: its own end date, else CURRENCY_DAYS.food_lab from its date
  // (fssaiPaperUntil) — the same end that decides d.in_order, so a report a
  // year and more old is MISSING here and absent from the inspector's copy.
  // A report filed ahead of its valid-from date is not in force yet: never the current one.
  const ends = docs.filter((d) => d.stored > 0 && !d.starts_on).map((d) => ({ d, end: d.until }))
    .filter((x) => x.end).sort((a, b) => (a.end < b.end ? 1 : -1));
  const best = ends[0];
  const v = judgePeriod(best?.end || '', ctx.today, 'food lab report');
  p.status = v.status;
  p.problems = v.problems.map((x) => (x.startsWith('No ') ? `${x} (Needed only where applicable.)` : x));
  const labNotYet = docs.filter((d) => d.starts_on && d.stored > 0);
  if (!best && docs.length) {
    p.problems = labNotYet.length
      ? labNotYet.map((d) => `${docLabel(d)} is on file, but it is in force only from ${d.starts_on} — ${until(d.starts_on, ctx.today)}.`)
      : [`${docLabel(docs[0])} is recorded, but no copy of it is attached.`];
  }
  p.lapses_on = best?.end || '';
  const bestLapsed = !!best && best.end < ctx.today;
  p.headline = best
    ? `${docLabel(best.d)}, ${bestLapsed ? 'ran out on' : 'good until'} ${best.end}`
    : docs.length ? `${plural(docs.length, 'report')} on file, none usable` : 'Nothing on file';
  // Only what the inspector's copy carries is "on file"; a date already past is management's.
  const handed = docs.filter((d) => d.in_order).length;
  p.summary = [
    { label: 'On file', value: String(handed) },
    ...(docs.length > handed ? [{ label: 'Lapsed or without a copy', value: String(docs.length - handed), mgmt: true as const }] : []),
    bestLapsed || !best ? { label: 'Good until', value: best?.end || '—', mgmt: true as const } : { label: 'Good until', value: best.end },
  ];
  p.tables = [table('Food lab reports', DOC_COLUMNS, docRows(docs), ctx.limit, 'Nothing of this kind is on file.')];
  p.scans = docs.flatMap((d) => d.scans);
  if (p.status !== 'present') p.todo = todo;
  return p;
}

/* 20 ─ Previous audit report and closure evidence */
/**
 * The last visit, its report and how every point it raised was closed — read
 * through readFssaiVisitClosureEvidence (the closure lane's reader): the
 * report's LIVE copies (the linked document's live scans and the pages filed
 * on the visit itself), and per point the LIVE closure photographs from the
 * point AND from the corrective action it raised. Voided files are listed
 * apart and never counted. A photograph is optional (the owner has not ruled
 * it required), so its absence is shown, not judged.
 */
function previousAudit(ctx: Ctx): Part {
  const p = blank();
  p.links = [{ href: '/fssai/inspections', label: 'Inspection Reports' }, { href: '/fssai/corrective-actions', label: 'Corrective Actions' }, DOCS_LINK];
  p.basis =
    'The last visit recorded under Inspection Reports, its report (a copy filed under Documents & Certificates as "Previous audit report and closure evidence", ' +
    'linked to the visit, or photographed onto the visit), and every point it raised with what was done and the photographs of the fix (on the point or on ' +
    'its corrective action). PRESENT when a copy of THAT visit\'s report is on file and every point is closed; EXPIRING while points are open but not yet due; MISSING without ' +
    'a copy, or when an open point is past its due date. An audit report linked to another visit, or to none, is listed but is not the last visit\'s report. ' +
    'Voided pages and photographs are kept and listed, never counted.';
  const todo =
    'Record the last visit under Inspection Reports with each point it raised, close each point with what was done (and a photograph of the fix), and link or photograph the authority\'s report onto the visit.';
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
  const ev = last && ctx.present.has('fssai_attachments') ? readFssaiVisitClosureEvidence(ctx.db, [s(last.id)]).get(s(last.id)) : undefined;

  // THE REPORT COPIES — of the LAST VISIT ONLY: the document linked to it (its
  // live scans) and the pages photographed onto the visit itself. That is
  // ev.report.copies, the closure lane's own count, so this record and the
  // Inspection Reports screen cannot disagree. An audit-report document that
  // belongs to another visit, or is linked to none, is listed under "Audit
  // reports on file" — but it is never THIS visit's report: counting it would
  // let a newer visit with no report of its own read PRESENT on an older one.
  const scans: AuditFileScan[] = [];
  const visitLabel = last ? `Report of the visit on ${s(last.business_date)}` : 'Report';
  const linkedId = ev?.report.document?.id || '';
  let copies = 0;
  // The linked document is the visit's report only while the one judge holds
  // it in order (fssaiVisitReportInOrder): an audit certificate whose expiry
  // has passed is EXPIRED on "Audit reports on file" and left off Inspection
  // Mode — its scan must not reach the inspector's copy under "Copies on file"
  // either, nor count as a report copy.
  const rep = ev ? fssaiVisitReportInOrder(ctx.db, ctx.paper, ev) : null;
  if (ev && rep) {
    copies = rep.copies;
    const doc = ev.report.document;
    if (doc) {
      scans.push(...doc.scans.map((f) => {
        const sc = closureScan(f, `${visitLabel} — ${doc.title || doc.doc_type_label}`);
        sc.in_handover = rep.document_in_order;
        return sc;
      }));
    }
    scans.push(...ev.report.files.map((f) => closureScan(f, `${visitLabel} — page filed on the visit`)));
    scans.push(...ev.report.voided_files.map((f) => closureScan(f, `${visitLabel} — page filed on the visit`)));
  }
  // With no visit recorded at all, a filed audit report is the only record of
  // the last audit there is: its live copies stand (no points to judge) — the
  // copies of a report the judge holds in order, never an expired one's.
  if (!last) copies = reportDocs.filter((d) => d.in_order).reduce((a, d) => a + d.stored, 0);
  const otherReports = reportDocs.filter((d) => d.id !== linkedId);
  scans.push(...otherReports.flatMap((d) => d.scans));

  const findings = last ? ctx.db.prepare(
    `SELECT f.id, f.finding_no, f.clause_ref, f.severity, f.observation, f.due_date, f.status, f.response, f.closed_at, f.closed_by,
            ca.ca_number, ca.status AS ca_status, ca.action_taken, ca.verified_by
       FROM fssai_inspection_findings f
       LEFT JOIN fssai_corrective_actions ca ON ca.id = f.ca_id
      WHERE f.inspection_id = ?
      ORDER BY f.sort_order, f.finding_no`,
  ).all(s(last.id)) as any[] : [];
  const evBy = new Map((ev?.findings || []).map((f) => [f.finding_id, f]));
  for (const f of findings) {
    const e = evBy.get(s(f.id));
    if (!e) continue;
    const lbl = `Point ${s(f.finding_no) || e.finding_no}: ${s(f.observation).slice(0, 60)} — closure photograph`;
    scans.push(...e.closure_files.map((x) => closureScan(x, lbl)));
    scans.push(...e.voided_files.map((x) => closureScan(x, lbl)));
  }
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
      ? `The visit on ${s(last.business_date)}${s(last.authority) ? ` by ${s(last.authority)}` : ''} is recorded, but no live copy of its report is on file.` +
        (otherReports.length
          ? ` ${otherReports.length === 1 ? 'The audit report on file is' : `The ${otherReports.length} audit reports on file are`} not linked to this visit, so ${otherReports.length === 1 ? 'it is' : 'they are'} not its report — ` +
            'link the right one to the visit on Inspection Reports, or photograph the report\'s pages onto the visit.'
          : '')
      : (() => {
        const lapsed = reportDocs.find((d) => d.stored > 0 && !d.in_order);
        return lapsed
          ? `${docLabel(lapsed)} is recorded, but it is not in order today: ${lapsed.why_not}.`
          : 'An audit report is recorded, but no copy of it is attached.';
      })());
  }
  if (ev && ev.report.document_problem) problems.push(ev.report.document_problem);
  // Why the visit has no report copy, when the linked one has a copy the judge
  // does not hold in order. (With the visit's own pages on file the record
  // stands on them, and the lapsed document is just its EXPIRED row on "Audit
  // reports on file", as an expired licence beside a current one is.)
  if (rep && rep.document_why && !copies) {
    problems.push(
      `The report linked to it (${rep.document_label}) is not in order today: ${rep.document_why} — so it is not counted as the visit's report. ` +
      'Link the visit\'s own report on Inspection Reports, or photograph its pages onto the visit.',
    );
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

  const settled = ev ? ev.counts.settled : 0;
  const withPhoto = ev ? ev.counts.settled_with_photo : 0;
  p.status = status;
  p.problems = problems;
  p.headline = last
    ? `Last visit ${s(last.business_date)}${s(last.authority) ? ` — ${s(last.authority)}` : ''} · ${plural(findings.length, 'point')}, ${open.length} open · ` +
      `${plural(copies, 'report copy', 'report copies')}${settled ? ` · ${withPhoto} of ${settled} closed with a photograph` : ''}`
    : reportDocs.length ? `${plural(reportDocs.length, 'audit report')} on file` : 'Nothing recorded';
  p.summary = [
    { label: 'Visits recorded', value: String(visits.length) },
    { label: 'Last visit', value: last ? s(last.business_date) : '—' },
    { label: 'Points raised', value: String(findings.length) },
    { label: 'Still open', value: String(open.length) },
    { label: 'Report copies', value: String(copies) },
    { label: 'Closed with a photograph', value: `${withPhoto} of ${settled}`, mgmt: true },
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
      { label: 'No.', width: 0.5 }, { label: 'Clause', width: 0.7 }, { label: 'Observation', width: 2.2 }, { label: 'Due', width: 0.9 },
      { label: 'Status', width: 0.8 }, { label: 'What was done', width: 2.1 }, { label: 'Checked by', width: 1.1 }, { label: 'Photos', width: 0.6, align: 'right' },
    ], findings.map((f) => {
      const e = evBy.get(s(f.id));
      const photos = e ? e.closure_files.filter((x) => x.has_image).length : 0;
      return row([
        s(f.finding_no), s(f.clause_ref), s(f.observation), s(f.due_date), s(f.status).replace(/_/g, ' '),
        s(f.action_taken) || s(f.response), personWords(ctx.db, s(f.verified_by) || s(f.closed_by)), photos ? String(photos) : '—',
      ], '/fssai/inspections', overdue.includes(f) ? 'bad' : isOpen(f) ? 'warn' : '');
    }), ctx.limit, 'The visit raised no points.'),
    table('Audit reports on file', DOC_COLUMNS, docRows(reportDocs), ctx.limit, 'No audit report document is on file.'),
  ];
  p.scans = scans;
  // The last visit with no report copy of its own: nothing of this record goes
  // into the inspector's copy — not the visit list, not another visit's report
  // printed under "20. Previous audit report" as if it were the last one.
  if (last && !copies) keepOutOfHandover(p.tables, p.scans);
  if (p.status !== 'present') p.todo = todo;
  return p;
}

/* ══════════════════════════════════════════════════════════════════════════
 * BEYOND THE 20 — the authority's own checklist pages, answered
 * ══════════════════════════════════════════════════════════════════════════ */

/** A line's words for comparison: case, runs of spaces and dash kinds ignored. */
function hydNorm(x: unknown): string {
  return s(x).toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
}

/** YES / NO / N/A / '' — the mark fssaiHydAnswerSheet prints for an answer. */
function hydMarkOf(a: HydAnswer | undefined): string {
  if (!a) return '';
  if (Number(a.is_na) === 1) return 'N/A';
  if (a.value_bool === null || a.value_bool === undefined) return '';
  return Number(a.value_bool) === 1 ? 'YES' : 'NO';
}

/**
 * The authority's three checklist pages (CHECKLIST 1–3 of its workbook), each
 * with the LAST submitted or verified self-audit round laid back onto the page:
 * the same rows, words and order, YES / NO / REMARK filled in (the pack's
 * fssaiHydAnswerSheet). This is how an inspector reads the PASSING answers —
 * every other screen shows a round as a name, a date and a fail count.
 *
 * The template is found by the code the pack seeded it as, or — after the owner
 * renamed it — by the seed log's record of what that code created. Read-only.
 * Never throws: a page that cannot be read says why in `problem`.
 * Each answer is laid on its line by code AND checked by its words: one whose
 * stored question no longer reads as that line goes to the line its words
 * match, or is listed apart — never printed against another line (`drift`).
 */
export function readHydSelfAudit(db: Database.Database, today: string, since: string): AuditFileSelfAudit[] {
  const present = fssaiTablesPresent(db);
  const need = ['fssai_runs', 'fssai_templates', 'fssai_responses', 'fssai_questions'];
  const missing = need.filter((t) => !present.has(t));
  const out: AuditFileSelfAudit[] = [];
  for (const sheet of FSSAI_HYD_WORKBOOK.slice(1)) {
    const code = sheet.template_code;
    const page: AuditFileSelfAudit = {
      sheet: sheet.name, template_code: code, template_name: '', run: null,
      rows: sheet.rows.filter((r) => r.kind !== 'title').map((r) => ({
        kind: r.kind, text: r.text, mark: '', remark: '', question_code: String(r.question_code || ''),
      })),
      counts: { lines: sheet.rows.filter((r) => r.kind === 'line').length, yes: 0, no: 0, na: 0, unanswered: sheet.rows.filter((r) => r.kind === 'line').length },
      extra: [], rounds_in_window: 0, problem: '', drift: [],
    };
    out.push(page);
    if (missing.length) { page.problem = NOT_IN_DB(missing); continue; }
    try {
      const viaSeed = present.has('fssai_seed_log')
        ? ` OR t.id IN (SELECT item_id FROM fssai_seed_log WHERE item_kind = 'template' AND action = 'inserted' AND item_code = ?)`
        : '';
      const tpls = db.prepare(
        `SELECT t.id, t.name, t.code, t.status FROM fssai_templates t WHERE t.code = ?${viaSeed}`,
      ).all(...(viaSeed ? [code, code] : [code])) as any[];
      if (!tpls.length) {
        page.problem = `The ready-made ${sheet.name} checklist (${code}) is not in this database. An administrator adds it under FSSAI Settings → Ready-made checklists.`;
        continue;
      }
      page.template_name = s(tpls[0].name);
      const ids = tpls.map((t) => s(t.id));
      const marks = ids.map(() => '?').join(',');
      const run = db.prepare(
        `SELECT r.id, r.business_date, r.status, r.outcome, r.recorded_name, r.recorded_by, r.signed_by
           FROM fssai_runs r
          WHERE r.template_id IN (${marks}) AND r.status IN ('submitted','verified') AND r.voided_at = '' AND r.business_date <= ?
          ORDER BY r.business_date DESC, r.submitted_at DESC, r.started_at DESC LIMIT 1`,
      ).get(...ids, today) as any;
      page.rounds_in_window = intOr((db.prepare(
        `SELECT COUNT(*) AS n FROM fssai_runs r
          WHERE r.template_id IN (${marks}) AND r.status IN ('submitted','verified') AND r.voided_at = ''
            AND r.business_date >= ? AND r.business_date <= ?`,
      ).get(...ids, since, today) as any)?.n);
      if (!run) {
        page.problem = tpls.every((t) => s(t.status) !== 'published')
          ? `${sheet.name} (${page.template_name}) is not published yet, so nobody can run it. An administrator publishes it under FSSAI Settings → Ready-made checklists.`
          : `No round of ${sheet.name} (${page.template_name}) has been submitted yet. Run it on FSSAI Checklists.`;
        continue;
      }
      // THE NAME AS IT WAS RECORDED (owner §7 Q15): a past round is labelled with
      // the checklist's name frozen in that round's snapshot, as Reports does —
      // the live name only when no snapshot was written.
      if (present.has('fssai_audit_log')) {
        const frozen = db.prepare(
          `SELECT json_extract(after_json, '$.template.name') AS n FROM fssai_audit_log
            WHERE entity_table = 'fssai_runs' AND entity_id = ? AND action = 'snapshot' ORDER BY rowid DESC LIMIT 1`,
        ).get(s(run.id)) as any;
        if (s(frozen?.n)) page.template_name = s(frozen.n);
      }
      page.run = {
        id: s(run.id), business_date: s(run.business_date), status: s(run.status), outcome: s(run.outcome),
        recorded_by: personWords(db, run.recorded_name || run.recorded_by), signed_by: personWords(db, run.signed_by),
        href: `/fssai/checklists/run/${encodeURIComponent(s(run.id))}`,
      };
      const answers = db.prepare(
        `SELECT q.code AS question_code, COALESCE(NULLIF(r.prompt_snapshot, ''), q.prompt) AS prompt,
                r.value_bool, r.is_na, r.note
           FROM fssai_responses r JOIN fssai_questions q ON q.id = r.question_id
          WHERE r.run_id = ?`,
      ).all(s(run.id)) as any[];
      // AN ANSWER SITS ON THE LINE IT WAS ASKED AS — checked by its WORDS, not
      // its code alone. The code is editable in the builder, and a page seeded
      // by an older pack numbers its lines differently; laid by code alone, a
      // shifted page would print "Floors greasy by fryer" against "Walls" on
      // the authority's own sheet. So each answer's question (as frozen on the
      // round, else as now) must read as the line with its code — the line's
      // words, or "<lead-in>: <words>" as the pack asks it (hydPrompt). One
      // that does not is laid on the line its words DO match, when exactly one
      // free line does; otherwise it is listed with its own words, never on a
      // line. Either way management is told (page.drift).
      const sheetLines = sheet.rows.filter((r) => r.kind === 'line' && String(r.question_code || ''));
      const lineText = new Map(sheetLines.map((r) => [String(r.question_code), hydNorm(r.text)]));
      const fits = (prompt: string, text: string): boolean => {
        const p = hydNorm(prompt);
        return !!text && (p === text || p.endsWith(`: ${text}`) || p.endsWith(`- ${text}`));
      };
      const shaped = answers.filter((a) => s(a.question_code)).map((a) => ({
        qc: s(a.question_code), prompt: s(a.prompt),
        ans: {
          value_bool: a.value_bool === null || a.value_bool === undefined ? null : Number(a.value_bool),
          is_na: intOr(a.is_na), note: s(a.note),
        } as HydAnswer,
      }));
      const map = new Map<string, HydAnswer>();
      const promptOf = new Map<string, string>();
      const astray: typeof shaped = [];
      // First every answer that reads as its own line (or is not on the page at
      // all: a question the owner added); then the ones that do not.
      for (const a of shaped) {
        const own = lineText.get(a.qc);
        const ownLine = own !== undefined && fits(a.prompt, own);
        const ownerAdded = own === undefined && !sheetLines.some((r) => fits(a.prompt, lineText.get(String(r.question_code)) || ''));
        if (ownLine || ownerAdded) { map.set(a.qc, a.ans); promptOf.set(a.qc, a.prompt); } else astray.push(a);
      }
      const unplaced: Array<{ question_code: string; prompt: string; mark: string; remark: string }> = [];
      for (const a of astray) {
        const free = sheetLines.filter((r) => !map.has(String(r.question_code)) && fits(a.prompt, lineText.get(String(r.question_code)) || ''));
        // The longest matching words, so "Walls" never wins over "Floors and walls".
        free.sort((x, y) => (lineText.get(String(y.question_code)) || '').length - (lineText.get(String(x.question_code)) || '').length);
        const target = free[0] ? String(free[0].question_code) : '';
        const unique = !!target && free.filter((r) => (lineText.get(String(r.question_code)) || '').length === (lineText.get(target) || '').length).length === 1;
        if (unique) {
          map.set(target, a.ans);
          promptOf.set(target, a.prompt);
          page.drift.push(`The answer stored as ${a.qc} ("${a.prompt}") reads as the authority's line ${target}, so it is laid there.`);
        } else {
          unplaced.push({ question_code: a.qc, prompt: a.prompt, mark: hydMarkOf(a.ans), remark: s(a.ans.note) });
          page.drift.push(`The answer stored as ${a.qc} ("${a.prompt}") reads as no free line of the authority's page, so it is listed apart and laid on none.`);
        }
      }
      if (page.drift.length) {
        page.drift.push(`The ${sheet.name.trim()} checklist in the builder no longer numbers or words its questions as the authority's page does — an administrator restores each question's code and words (FSSAI Settings → Checklists).`);
      }
      const sheetAns = fssaiHydAnswerSheet(code, map);
      if (!sheetAns) { page.problem = `${code} is not one of the authority's pages.`; continue; }
      page.rows = sheetAns.rows.filter((r) => r.kind !== 'title').map((r: HydAnswerSheetRow) => ({
        kind: r.kind, text: r.text, mark: String(r.mark || ''), remark: String(r.remark || ''), question_code: String(r.question_code || ''),
      }));
      page.counts = { ...sheetAns.counts };
      page.extra = [...sheetAns.extra.map((x) => ({ ...x, prompt: promptOf.get(x.question_code) || '' })), ...unplaced];
    } catch (e: any) {
      page.problem = `This page could not be read (${String(e?.message || e)}).`;
    }
  }
  return out;
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
  medical: (ctx) => handlerRecord(ctx, 'medical'),
  training: (ctx) => handlerRecord(ctx, 'training'),
  vendors,
  receiving,
  // The log is one reading per UNIT under Temperature Logs. The cold-store
  // checklist's "coldest chiller / freezer reading seen on this round" is one
  // spot figure for the whole round — its own description says "the
  // temperature of each unit is logged separately under Temperature Logs" —
  // so it never counts here, and the todo never sends anyone to it.
  cold_temps: (ctx) => tempLog(ctx, 'cold_temps', ['equipment'], ['equipment'], 'refrigerator or freezer reading',
    'Read every refrigerator, freezer and cold room on its round and record each unit\'s reading under Temperature Logs (kind "Equipment"). ' +
    'The cold-store checklist\'s single "reading seen on this round" does not replace this log.',
    [{ href: '/fssai/temperature', label: 'Temperature Logs' }, { href: '/fssai/cold-rooms', label: 'Cold Room Climate Control' }]),
  cooking_temps: (ctx) => tempLog(ctx, 'cooking_temps', ['cooking', 'reheating', 'cooling', 'hot_holding'], ['cooking', 'reheating'],
    'cooking or reheating temperature',
    'Probe the core of cooked and reheated food and record each reading under Temperature Logs (kind "Cooking" or "Reheating") — cooling and hot-holding readings are kept too, but they are not this log.',
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
  const present = fssaiTablesPresent(db);
  const since = addDaysISO(today, -(days - 1));
  const ctx: Ctx = {
    db,
    today,
    days,
    since,
    limit: Math.max(1, Math.min(Number(opts.rowLimit) || 8, 2000)),
    present,
    // The pack's own test (code, category, or "the pack created it under that
    // code" from the seed log) when the seed log is here; the code and the
    // category alone when it is not — never a SQL error on an older database.
    notHydAudit: present.has('fssai_seed_log')
      ? `NOT ${fssaiHydAuditTemplateSql('t')}`
      : `NOT (t.code IN (${FSSAI_HYD_AUDIT_CODES.map((c) => `'${c.replace(/'/g, "''")}'`).join(', ')}))`,
    paper: fssaiHandoverPaperJudge(db, today),
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
    // VOID, NEVER A COPY — one partition for all 20, so no record can forget
    // it: a voided file leaves `scans` (what counts, what the PDF draws) for
    // `voided_scans` (kept, shown with its reason on the page and the
    // management copy, never in the handover).
    const seen = new Set<string>();
    const voided: AuditFileScan[] = [];
    for (const sc of [...part.voided_scans, ...part.scans.filter((x) => x.status === 'void')]) {
      if (seen.has(sc.attachment_id)) continue;
      seen.add(sc.attachment_id);
      voided.push(sc);
    }
    part.voided_scans = voided;
    part.scans = part.scans.filter((x) => x.status !== 'void');
    // HELD — one rule for all 20, from what the record will actually print:
    // a line the handover may carry, or a LIVE copy still stored that the
    // handover may carry (not the scan of an expired paper, not a file that
    // only travels beside a record the copy does not hold).
    part.held = part.tables.some((t) => t.handover_rows > 0) || part.scans.some((sc) => isLiveCopy(sc) && sc.in_handover);
    return { n: rec.n, key: rec.key, title: rec.title, ...part };
  });

  const counts = { present: 0, expiring: 0, missing: 0, total: items.length };
  for (const it of items) counts[it.status]++;
  const held = items.filter((i) => i.held).map((i) => i.n);
  let selfAudit: AuditFileSelfAudit[] = [];
  try {
    selfAudit = readHydSelfAudit(db, today, since);
  } catch (e: any) {
    console.error('[fssai/audit-file] self-audit pages failed:', e?.message || e);
  }
  return {
    section: AUDIT_FILE_SECTION, today, days, since, counts, items,
    handover: { held, left_out: items.filter((i) => !i.held).map((i) => i.n), count: held.length, total: items.length },
    self_audit: selfAudit,
  };
}

/**
 * The one sentence every copy handed over carries about itself — how many of
 * the authority's 20 it holds. Never implies a complete file: a copy holding
 * 14 says 14 (owner, 2026-10-14). Facts about the DOCUMENT, not the premises.
 */
export function auditFileHoldsWords(f: Pick<AuditFile, 'handover'>): string {
  const { count, total, held } = f.handover;
  if (count === total) return `This copy contains all ${total} records on the authority's list.`;
  if (!count) return `This copy contains none of the ${total} records on the authority's list.`;
  return `This copy contains ${count} of the ${total} records on the authority's list — numbers ${held.join(', ')}.`;
}

export const AUDIT_FILE_STATUS_WORDS: Record<AuditFileStatus, string> = {
  present: 'PRESENT',
  expiring: 'EXPIRING',
  missing: 'MISSING',
};
