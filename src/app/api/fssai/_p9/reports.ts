/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';
import {
  fssaiCheckResultLabel, fssaiDocState, fssaiDocStateMeta, fssaiDocType,
  fssaiExpiryStateMeta, fssaiFindingSeverityMeta, fssaiFindingStatusMeta,
  fssaiInspectionStatusMeta, fssaiCaStatusMeta, fssaiCaSeverityMeta,
  fssaiReceivingDecisionMeta, fssaiRecordStatusMeta, fssaiRunStatusMeta,
  fssaiPestServiceStatusMeta, fssaiPestSeverityMeta,
  fssaiTempLogKindLabel, fssaiWaterTestKind, FSSAI_TEMP_LOG_KINDS,
} from '@/lib/fssai';
import { dateClause, deptLabel, fssaiTablesPresent, intOr, intOrBlank, numOrBlank, whereAll, type DateWindow } from './lib';
import { fssaiPaperInForce } from '../audit-file/lib';
import {
  fssaiCurveMembers, fssaiCurveReached, fssaiCurveRule, fssaiCurveExpectedShown, fssaiTempDirection,
  fssaiReadingScheduleValue, fssaiTempVerdictWord, fssaiTempMinutesWords, fssaiNowMinuteIST,
  type FssaiCurveMember,
} from '../_p4/lib';

/**
 * THE FSSAI REPORT REGISTRY (owner §18).
 *
 * ── THE CONTRACT, AND WHY IT IS THIS SHAPE ──────────────────────────────────
 * RECON §7.1 names /api/hr/reports as the best-built report server in this
 * codebase: "a generic module contract of COLUMNS plus run(db, outletId, from,
 * to) per report. Copy it — one file per FSSAI report, a thin route that
 * dispatches." This is that contract, with the per-report files collapsed into
 * one module because an FSSAI report is a dozen lines of SQL rather than a
 * hundred, and twenty files of twelve lines is harder to keep consistent than
 * one list anybody can read end to end.
 *
 * Every report returns `cells` — an array per row, in the same order as
 * `columns`. One ordering, used by the screen, the CSV and the PDF, so a column
 * cannot appear in a different place depending on which button was pressed.
 *
 * ── FOUR RULES EVERY run() IN HERE OBEYS ────────────────────────────────────
 * 1. A NULL REAL IS BLANK, NEVER 0. numOrBlank, everywhere. Every :R column in
 *    this schema means NOT RECORDED when it is NULL, and "0 °C" printed for a
 *    reading nobody took is a fabricated observation on an inspector's sheet.
 * 2. THE FROZEN VERDICT IS READ, NEVER RECOMPUTED. is_fail, is_judged, min_used
 *    and max_used are what the standard said AT THE TIME. A report that re-tests
 *    a reading against today's standard rewrites history — tightening a range
 *    next month must not retrospectively fail a fridge that passed.
 * 3. VOIDED ROWS ARE SHOWN, NOT HIDDEN — with their status and their reason.
 *    §19 is "void, never delete"; a report that filters them out undoes that.
 *    The default status filter is therefore 'all', and `status=active` is the
 *    deliberate choice that excludes them.
 * 4. NO DATE DEFAULT. See dateWindow in ./lib — the owner has already been
 *    burned by a report that silently showed an empty window.
 */

export interface FssaiReportCol {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  /** Relative width for the PDF table. Omitted columns get 1. */
  width?: number;
  /** Narrow screens hide this column in the on-screen table. */
  secondary?: true;
}

export interface FssaiReportCtx {
  db: Database.Database;
  today: string;
  window: DateWindow;
  /** '' = every department. Matched on ID — live names contain double spaces. */
  departmentId: string;
  /** 'all' (default) | 'active' (exclude voided) | a specific status value */
  status: string;
  /** Free text across the report's own searchable columns. '' = no filter. */
  q: string;
  limit: number;
}

export interface FssaiReportKpi { label: string; value: string; sub?: string }

export interface FssaiReportResult {
  cells: Array<Array<string | number>>;
  kpis?: FssaiReportKpi[];
  /** A caveat printed under the table, on screen and in the PDF. */
  note?: string;
  /** true when `limit` cut the list short. */
  truncated?: boolean;
}

export interface FssaiReportDef {
  key: string;
  label: string;
  group: 'Checks' | 'Deliveries' | 'Temperature' | 'Stock' | 'Oil, water and pests' | 'The file';
  blurb: string;
  /** Every table this report reads. A missing one makes the report unavailable. */
  requires: string[];
  /** What the date range filters on, in words, so the screen can say it. */
  dateLabel: string;
  /** false when the table carries no department_id, so the filter is hidden. */
  hasDepartment: boolean;
  columns: FssaiReportCol[];
  run(ctx: FssaiReportCtx): FssaiReportResult;
}

/* ══════════════════════════════════════════════════════════════════════════
 * shared fragments
 * ══════════════════════════════════════════════════════════════════════════ */

const LIMIT_MAX = 5000;

function lim(ctx: FssaiReportCtx): number {
  const n = Number(ctx.limit);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), LIMIT_MAX) : 1000;
}

/** The department filter, as a filter and not as a fence (this route is management). */
function deptFilter(ctx: FssaiReportCtx, alias: string) {
  if (!ctx.departmentId) return null;
  return { sql: `${alias}.department_id = ?`, args: [ctx.departmentId] };
}

/**
 * The status filter. 'all' is the default and includes voided rows, because §19
 * says a voided record stays in the file. 'active' is the deliberate exclusion.
 */
function statusFilter(ctx: FssaiReportCtx, alias: string, voidValue = 'void') {
  const s = String(ctx.status || 'all');
  if (!s || s === 'all') return null;
  if (s === 'active') return { sql: `${alias}.status <> ?`, args: [voidValue] };
  return { sql: `${alias}.status = ?`, args: [s] };
}

/** Free-text filter across the named columns. */
function textFilter(ctx: FssaiReportCtx, cols: string[]) {
  const q = String(ctx.q || '').trim();
  if (!q || !cols.length) return null;
  const like = `%${q.toLowerCase()}%`;
  return {
    sql: cols.map((c) => `lower(IFNULL(${c},'')) LIKE ?`).join(' OR '),
    args: cols.map(() => like),
  };
}

function deptName(ctx: FssaiReportCtx, id: unknown): string {
  // One definition of "name a department, or say its id" — see deptLabel.
  return deptLabel(DEPT_CACHE.get(ctx.db) || new Map(), id);
}

/**
 * Department names, memoised per database handle for the life of the process.
 * A report that joins departments twenty times to print a name is twenty joins
 * for a map of fifteen rows.
 */
const DEPT_CACHE = new WeakMap<object, Map<string, string>>();
export function primeDeptNames(db: Database.Database, names: Map<string, string>): void {
  DEPT_CACHE.set(db as unknown as object, names);
}

/** A judged/unjudged reading, in words. is_judged = 0 is not a pass. */
function verdictWord(isFail: unknown, isJudged: unknown): string {
  if (intOr(isJudged, 1) === 0) return 'Not judged';
  return intOr(isFail, 0) === 1 ? 'FAIL' : 'In range';
}

/**
 * The verdict word for a temperature reading — 'On schedule' for a cooling or
 * reheating reading that passed while still short of its target. ONE definition,
 * `fssaiTempVerdictWord` in _p4/lib, shared with the temperature page and (for
 * the audit-file PDF) whoever prints the same row, so the three cannot say
 * different words for it. Read from the frozen columns only.
 */
function tempVerdictWord(r: any): string {
  return fssaiTempVerdictWord(r);
}

/** "60 of 240" — and "0 of 240" for a reading at minute 0 (fssaiTempMinutesWords). */
function minutesWords(r: any): string {
  return fssaiTempMinutesWords(r);
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Cooling and reheating — the kinds judged on a clock and kept as a curve. */
function isRateKind(logKind: unknown): boolean {
  return !!FSSAI_TEMP_LOG_KINDS.find((k) => k.key === String(logKind || ''))?.window_minutes;
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE REPORTS
 * ══════════════════════════════════════════════════════════════════════════ */

export const FSSAI_REPORTS: FssaiReportDef[] = [
  /* ── 1. every checklist record ─────────────────────────────────────────── */
  {
    key: 'checklist-records',
    label: 'Checklist records',
    group: 'Checks',
    blurb: 'Every round of every checklist that was filled in, with its verdict and who signed it.',
    requires: ['fssai_runs', 'fssai_templates'],
    dateLabel: 'the day the check belongs to',
    hasDepartment: true,
    columns: [
      { key: 'business_date', label: 'Date', width: 1 },
      { key: 'checklist', label: 'Checklist', width: 2.6 },
      { key: 'shift', label: 'Shift', width: 0.9 },
      { key: 'target', label: 'Checked', width: 1.6, secondary: true },
      { key: 'department', label: 'Department', width: 1.4, secondary: true },
      { key: 'answered', label: 'Answered', align: 'right', width: 0.9 },
      { key: 'failed', label: 'Failed', align: 'right', width: 0.7 },
      { key: 'outcome', label: 'Outcome', width: 0.9 },
      { key: 'status', label: 'Status', width: 1 },
      { key: 'recorded_by', label: 'Recorded by', width: 1.6, secondary: true },
      { key: 'signed', label: 'Signed', width: 1.2, secondary: true },
    ],
    run(ctx) {
      /* THE NAME AS IT WAS RECORDED, not as it is today (owner §7 Q15). A
       * rename does not bump a template version, so reading the live name would
       * silently re-label every record ever taken under that checklist. The sheet
       * was frozen into fssai_audit_log at submit; json_extract reads its title
       * here exactly as the §6 2026-09-18 note says a history list should. */
      const w = whereAll([
        dateClause('r.business_date', ctx.window),
        deptFilter(ctx, 'r'),
        statusFilter(ctx, 'r'),
        textFilter(ctx, ['t.name', 'r.target_label', 'r.recorded_by', 'r.recorded_name']),
      ]);
      const rows = ctx.db.prepare(
        `SELECT r.*,
                t.name AS live_name,
                json_extract(s.after_json, '$.template.name') AS recorded_name_frozen
           FROM fssai_runs r
           LEFT JOIN fssai_templates t ON t.id = r.template_id
           LEFT JOIN fssai_audit_log s
                  ON s.entity_table = 'fssai_runs' AND s.entity_id = r.id AND s.action = 'snapshot'
           ${w.sql}
          ORDER BY r.business_date DESC, r.started_at DESC
          LIMIT ?`,
      ).all(...w.args, lim(ctx) + 1) as any[];

      const truncated = rows.length > lim(ctx);
      const page = truncated ? rows.slice(0, lim(ctx)) : rows;
      let failedRuns = 0;
      let signed = 0;
      const cells = page.map((r) => {
        if (String(r.outcome || '') === 'fail') failedRuns++;
        if (String(r.signed_by || '')) signed++;
        return [
          String(r.business_date || ''),
          String(r.recorded_name_frozen || r.live_name || '(checklist removed)'),
          String(r.shift || ''),
          String(r.target_label || ''),
          deptName(ctx, r.department_id),
          `${intOr(r.answered_count)}/${intOr(r.total_count)}`,
          intOr(r.fail_count),
          String(r.outcome || '') ? String(r.outcome).toUpperCase() : '',
          fssaiRunStatusMeta(r.status).label,
          String(r.recorded_name || r.recorded_by || ''),
          String(r.signed_by || ''),
        ];
      });
      return {
        cells,
        truncated,
        kpis: [
          { label: 'Records', value: String(page.length) },
          { label: 'Failed rounds', value: String(failedRuns) },
          { label: 'Signed', value: `${signed} of ${page.length}` },
        ],
        note:
          'The checklist name is the one frozen with the record, so a later rename does not re-label history. ' +
          'A voided record is included and marked Voided — nothing is deleted from this file.',
      };
    },
  },

  /* ── 2. the failures themselves ────────────────────────────────────────── */
  {
    key: 'checklist-failures',
    label: 'Failed answers',
    group: 'Checks',
    blurb: 'Every individual answer that failed, the question as it was asked, and the corrective action against it.',
    requires: ['fssai_runs', 'fssai_responses'],
    dateLabel: 'the day the check belongs to',
    hasDepartment: true,
    columns: [
      { key: 'business_date', label: 'Date', width: 1 },
      { key: 'checklist', label: 'Checklist', width: 1.8 },
      { key: 'question', label: 'Question as asked', width: 3 },
      { key: 'answer', label: 'Answer', width: 1.4 },
      { key: 'rule', label: 'Rule applied', width: 1.4, secondary: true },
      { key: 'department', label: 'Department', width: 1.2, secondary: true },
      { key: 'recorded_by', label: 'Recorded by', width: 1.4, secondary: true },
      { key: 'ca', label: 'Corrective action', width: 1.2 },
    ],
    run(ctx) {
      const w = whereAll([
        { sql: `p.is_fail = 1`, args: [] },
        dateClause('r.business_date', ctx.window),
        deptFilter(ctx, 'r'),
        statusFilter(ctx, 'r'),
        textFilter(ctx, ['p.prompt_snapshot', 'p.value_text', 't.name']),
      ]);
      const hasCa = ctx.db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='fssai_corrective_actions' LIMIT 1`,
      ).get();
      const rows = ctx.db.prepare(
        `SELECT p.*, r.business_date, r.department_id, r.recorded_by, r.recorded_name, r.status AS run_status,
                t.name AS live_name,
                json_extract(s.after_json, '$.template.name') AS recorded_name_frozen
                ${hasCa ? `, (SELECT group_concat(c.ca_number, ', ') FROM fssai_corrective_actions c
                              WHERE c.response_id = p.id) AS ca_numbers` : `, '' AS ca_numbers`}
           FROM fssai_responses p
           JOIN fssai_runs r ON r.id = p.run_id
           LEFT JOIN fssai_templates t ON t.id = r.template_id
           LEFT JOIN fssai_audit_log s
                  ON s.entity_table = 'fssai_runs' AND s.entity_id = r.id AND s.action = 'snapshot'
           ${w.sql}
          ORDER BY r.business_date DESC, p.sort_order ASC
          LIMIT ?`,
      ).all(...w.args, lim(ctx) + 1) as any[];

      const truncated = rows.length > lim(ctx);
      const page = truncated ? rows.slice(0, lim(ctx)) : rows;
      let withCa = 0;
      const cells = page.map((r) => {
        if (String(r.ca_numbers || '')) withCa++;
        /* The answer in the words the record holds. value_num NULL stays blank:
         * a failure for "no reading taken" must not print as 0. */
        const parts: string[] = [];
        if (r.value_num !== null && r.value_num !== undefined) {
          parts.push(`${numOrBlank(r.value_num, intOr((r as any).decimals, 1))} ${String(r.uom || '')}`.trim());
        }
        if (r.value_bool !== null && r.value_bool !== undefined) parts.push(intOr(r.value_bool) === 1 ? 'Yes/Pass' : 'No/Fail');
        if (String(r.value_text || '')) parts.push(String(r.value_text));
        if (!parts.length) parts.push('No answer recorded');
        const rule: string[] = [];
        if (r.min_used !== null && r.min_used !== undefined) rule.push(`min ${numOrBlank(r.min_used, 1)}`);
        if (r.max_used !== null && r.max_used !== undefined) rule.push(`max ${numOrBlank(r.max_used, 1)}`);
        if (String(r.expected_used || '')) rule.push(`expected ${String(r.expected_used)}`);
        return [
          String(r.business_date || ''),
          String(r.recorded_name_frozen || r.live_name || '(checklist removed)'),
          String(r.prompt_snapshot || '(the question was not frozen on this record)'),
          parts.join(' · '),
          rule.join(', '),
          deptName(ctx, r.department_id),
          String(r.recorded_name || r.recorded_by || ''),
          String(r.ca_numbers || ''),
        ];
      });
      return {
        cells,
        truncated,
        kpis: [
          { label: 'Failed answers', value: String(page.length) },
          { label: 'With a corrective action', value: `${withCa} of ${page.length}` },
        ],
        note:
          'The rule shown is the one that was ACTUALLY APPLIED when the answer was given, read off the record. ' +
          'It is never recomputed against today’s standard — tightening a limit must not retrospectively fail a check that passed.',
      };
    },
  },

  /* ── 3. compliance by checklist ────────────────────────────────────────── */
  {
    key: 'checklist-compliance',
    label: 'Compliance by checklist',
    group: 'Checks',
    blurb: 'How many rounds of each checklist were filled in, how many failed, and how many are still waiting to be verified.',
    requires: ['fssai_runs', 'fssai_templates'],
    dateLabel: 'the day the check belongs to',
    hasDepartment: true,
    columns: [
      { key: 'checklist', label: 'Checklist', width: 3 },
      { key: 'code', label: 'Code', width: 1.1, secondary: true },
      { key: 'rounds', label: 'Rounds', align: 'right', width: 0.8 },
      { key: 'submitted', label: 'Submitted', align: 'right', width: 1 },
      { key: 'verified', label: 'Verified', align: 'right', width: 0.9 },
      { key: 'open', label: 'Still open', align: 'right', width: 1 },
      { key: 'voided', label: 'Voided', align: 'right', width: 0.8 },
      { key: 'failed', label: 'Failed rounds', align: 'right', width: 1.2 },
      { key: 'last', label: 'Last recorded', width: 1.2 },
    ],
    run(ctx) {
      const w = whereAll([dateClause('r.business_date', ctx.window), deptFilter(ctx, 'r')]);
      const rows = ctx.db.prepare(
        `SELECT t.id, t.name, t.code,
                COUNT(r.id) AS rounds,
                SUM(CASE WHEN r.status = 'submitted'   THEN 1 ELSE 0 END) AS submitted,
                SUM(CASE WHEN r.status = 'verified'    THEN 1 ELSE 0 END) AS verified,
                SUM(CASE WHEN r.status = 'in_progress' THEN 1 ELSE 0 END) AS still_open,
                SUM(CASE WHEN r.status = 'void'        THEN 1 ELSE 0 END) AS voided,
                SUM(CASE WHEN r.outcome = 'fail'       THEN 1 ELSE 0 END) AS failed,
                MAX(r.business_date) AS last_date
           FROM fssai_runs r
           JOIN fssai_templates t ON t.id = r.template_id
           ${w.sql}
          GROUP BY t.id
          ORDER BY rounds DESC, t.name ASC
          LIMIT ?`,
      ).all(...w.args, lim(ctx)) as any[];
      const cells = rows.map((r) => [
        String(r.name || ''),
        String(r.code || ''),
        intOr(r.rounds),
        intOr(r.submitted),
        intOr(r.verified),
        intOr(r.still_open),
        intOr(r.voided),
        intOr(r.failed),
        String(r.last_date || ''),
      ]);
      const totalRounds = rows.reduce((s, r) => s + intOr(r.rounds), 0);
      const totalFailed = rows.reduce((s, r) => s + intOr(r.failed), 0);
      return {
        cells,
        kpis: [
          { label: 'Checklists used', value: String(rows.length) },
          { label: 'Rounds recorded', value: String(totalRounds) },
          { label: 'Failed rounds', value: String(totalFailed) },
        ],
        note:
          'This counts rounds that were RECORDED. It does not say how many were DUE — that needs the schedule, and ' +
          'a figure claiming "95% compliance" built from records alone would be counting only the checks somebody chose to file.',
      };
    },
  },

  /* ── 4. compliance by department ───────────────────────────────────────── */
  {
    key: 'checklist-by-department',
    label: 'Checks by department',
    group: 'Checks',
    blurb: 'The same picture by department, so you can see where the checks are not being filed.',
    requires: ['fssai_runs'],
    dateLabel: 'the day the check belongs to',
    hasDepartment: false,
    columns: [
      { key: 'department', label: 'Department', width: 2.4 },
      { key: 'rounds', label: 'Rounds', align: 'right', width: 0.9 },
      { key: 'failed', label: 'Failed', align: 'right', width: 0.9 },
      { key: 'open', label: 'Still open', align: 'right', width: 1 },
      { key: 'voided', label: 'Voided', align: 'right', width: 0.9 },
      { key: 'people', label: 'People filing', align: 'right', width: 1.1 },
      { key: 'last', label: 'Last recorded', width: 1.2 },
    ],
    run(ctx) {
      const w = whereAll([dateClause('r.business_date', ctx.window)]);
      const rows = ctx.db.prepare(
        `SELECT r.department_id,
                COUNT(r.id) AS rounds,
                SUM(CASE WHEN r.outcome = 'fail' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN r.status = 'in_progress' THEN 1 ELSE 0 END) AS still_open,
                SUM(CASE WHEN r.status = 'void' THEN 1 ELSE 0 END) AS voided,
                COUNT(DISTINCT lower(r.recorded_by)) AS people,
                MAX(r.business_date) AS last_date
           FROM fssai_runs r
           ${w.sql}
          GROUP BY r.department_id
          ORDER BY rounds DESC
          LIMIT ?`,
      ).all(...w.args, lim(ctx)) as any[];
      const cells = rows.map((r) => [
        String(r.department_id || '') ? deptName(ctx, r.department_id) : 'Whole restaurant (no department)',
        intOr(r.rounds),
        intOr(r.failed),
        intOr(r.still_open),
        intOr(r.voided),
        intOr(r.people),
        String(r.last_date || ''),
      ]);
      return {
        cells,
        note:
          'A row reading "Whole restaurant" is a checklist configured to be filed once for the whole premises, ' +
          'not a record with a missing department.',
      };
    },
  },

  /* ── 5. delivery inspections ───────────────────────────────────────────── */
  {
    key: 'receiving-inspections',
    label: 'Delivery inspections',
    group: 'Deliveries',
    blurb: 'Every delivery checked at the door — vehicle, documents, how many lines failed and how many were rejected.',
    requires: ['fssai_receiving_checks'],
    dateLabel: 'the delivery date',
    hasDepartment: true,
    columns: [
      { key: 'business_date', label: 'Date', width: 1 },
      { key: 'check_no', label: 'Check no.', width: 1.1 },
      { key: 'vendor', label: 'Supplier', width: 2 },
      { key: 'grn', label: 'GRN', width: 1, secondary: true },
      { key: 'licence', label: 'Supplier licence', width: 1.4, secondary: true },
      { key: 'vehicle', label: 'Vehicle', width: 1, secondary: true },
      { key: 'vehicle_temp', label: 'Vehicle °C', align: 'right', width: 0.9 },
      { key: 'lines', label: 'Lines', align: 'right', width: 0.7 },
      { key: 'failed', label: 'Failed', align: 'right', width: 0.7 },
      { key: 'rejected', label: 'Rejected', align: 'right', width: 0.9 },
      { key: 'outcome', label: 'Outcome', width: 1.1 },
      { key: 'status', label: 'Status', width: 1 },
      { key: 'checked_by', label: 'Checked by', width: 1.4, secondary: true },
    ],
    run(ctx) {
      const w = whereAll([
        dateClause('c.business_date', ctx.window),
        deptFilter(ctx, 'c'),
        statusFilter(ctx, 'c'),
        textFilter(ctx, ['c.vendor_name', 'c.grn_number', 'c.check_no', 'c.invoice_number', 'c.vehicle_no']),
      ]);
      const rows = ctx.db.prepare(
        `SELECT c.* FROM fssai_receiving_checks c ${w.sql}
          ORDER BY c.business_date DESC, c.received_at DESC LIMIT ?`,
      ).all(...w.args, lim(ctx) + 1) as any[];
      const truncated = rows.length > lim(ctx);
      const page = truncated ? rows.slice(0, lim(ctx)) : rows;
      let expiredLicence = 0;
      const cells = page.map((r) => {
        const lic = String(r.supplier_licence_no || '');
        const exp = String(r.supplier_licence_expiry || '');
        if (exp && exp < ctx.today) expiredLicence++;
        return [
          String(r.business_date || ''),
          String(r.check_no || ''),
          String(r.vendor_name || ''),
          String(r.grn_number || ''),
          lic ? (exp ? `${lic} (to ${exp})` : lic) : '',
          String(r.vehicle_no || ''),
          numOrBlank(r.vehicle_temp_c, 1),
          intOr(r.line_count),
          intOr(r.fail_count),
          intOr(r.rejected_count),
          fssaiReceivingDecisionMeta(r.outcome).label,
          fssaiRecordStatusMeta(r.status).label,
          String(r.checked_name || r.checked_by || ''),
        ];
      });
      return {
        cells,
        truncated,
        kpis: [
          { label: 'Deliveries checked', value: String(page.length) },
          { label: 'With a failed line', value: String(page.filter((r) => intOr(r.fail_count) > 0).length) },
          { label: 'Supplier licence lapsed', value: String(expiredLicence) },
        ],
        note:
          'A blank vehicle temperature means no reading was taken, not 0 °C. ' +
          '"Supplier licence lapsed" compares the expiry recorded on the inspection against today.',
      };
    },
  },

  /* ── 6. the rejected lines ─────────────────────────────────────────────── */
  {
    key: 'receiving-rejections',
    label: 'Rejected and failed delivery lines',
    group: 'Deliveries',
    blurb: 'Line by line: what was sent back, how much, and the reason given.',
    requires: ['fssai_receiving_checks', 'fssai_receiving_lines'],
    dateLabel: 'the delivery date',
    hasDepartment: true,
    columns: [
      { key: 'business_date', label: 'Date', width: 1 },
      { key: 'vendor', label: 'Supplier', width: 1.6 },
      { key: 'material', label: 'Item', width: 2.2 },
      { key: 'lot', label: 'Lot', width: 0.9, secondary: true },
      { key: 'expiry', label: 'Expiry', width: 1, secondary: true },
      { key: 'received', label: 'Received', align: 'right', width: 0.9 },
      { key: 'accepted', label: 'Accepted', align: 'right', width: 0.9 },
      { key: 'rejected', label: 'Rejected', align: 'right', width: 0.9 },
      { key: 'uom', label: 'Unit', width: 0.7 },
      { key: 'temp', label: '°C', align: 'right', width: 0.6 },
      { key: 'decision', label: 'Decision', width: 1.2 },
      { key: 'reason', label: 'Reason', width: 2 },
    ],
    run(ctx) {
      const w = whereAll([
        { sql: `(l.is_fail = 1 OR l.decision IN ('rejected','partially_accepted'))`, args: [] },
        dateClause('c.business_date', ctx.window),
        deptFilter(ctx, 'c'),
        statusFilter(ctx, 'c'),
        textFilter(ctx, ['l.material_name', 'c.vendor_name', 'l.reject_reason', 'l.reject_note']),
      ]);
      const rows = ctx.db.prepare(
        `SELECT l.*, c.business_date, c.vendor_name, c.check_no
           FROM fssai_receiving_lines l
           JOIN fssai_receiving_checks c ON c.id = l.check_id
           ${w.sql}
          ORDER BY c.business_date DESC, l.sort_order ASC LIMIT ?`,
      ).all(...w.args, lim(ctx) + 1) as any[];
      const truncated = rows.length > lim(ctx);
      const page = truncated ? rows.slice(0, lim(ctx)) : rows;
      const cells = page.map((r) => [
        String(r.business_date || ''),
        String(r.vendor_name || ''),
        String(r.material_name || ''),
        String(r.lot_no || ''),
        String(r.expiry_date || ''),
        numOrBlank(r.qty_received, 3),
        numOrBlank(r.qty_accepted, 3),
        numOrBlank(r.qty_rejected, 3),
        String(r.uom || ''),
        numOrBlank(r.temp_c, 1),
        fssaiReceivingDecisionMeta(r.decision).label,
        [String(r.reject_reason || ''), String(r.reject_note || '')].filter(Boolean).join(' — '),
      ]);
      return {
        cells,
        truncated,
        note:
          'Quantities are in the unit the delivery was received in, as the inspection recorded it. ' +
          'A blank number means it was not recorded.',
      };
    },
  },

  /* ── 7. the temperature register ───────────────────────────────────────── */
  {
    key: 'temperature-log',
    label: 'Temperature register',
    group: 'Temperature',
    blurb: 'Every temperature taken, where, by whom, and whether it was inside the range in force at the time.',
    requires: ['fssai_temperature_logs'],
    dateLabel: 'the day the reading belongs to',
    hasDepartment: true,
    columns: [
      { key: 'business_date', label: 'Date', width: 1 },
      { key: 'reading_at', label: 'Time', width: 1, secondary: true },
      { key: 'kind', label: 'What', width: 1.6 },
      { key: 'where', label: 'Where', width: 1.8 },
      { key: 'item', label: 'Item', width: 1.4, secondary: true },
      { key: 'value', label: 'Reading', align: 'right', width: 0.9 },
      { key: 'uom', label: 'Unit', width: 0.6 },
      { key: 'range', label: 'Range applied', width: 1.2 },
      { key: 'minutes', label: 'Minutes', align: 'right', width: 0.9, secondary: true },
      { key: 'verdict', label: 'Verdict', width: 1 },
      { key: 'action', label: 'Action taken', width: 1.8, secondary: true },
      { key: 'by', label: 'By', width: 1.3, secondary: true },
      { key: 'status', label: 'Status', width: 0.9 },
    ],
    run(ctx) {
      const w = whereAll([
        dateClause('tl.business_date', ctx.window),
        deptFilter(ctx, 'tl'),
        statusFilter(ctx, 'tl'),
        textFilter(ctx, ['tl.equipment_label', 'tl.area_label', 'tl.item_label', 'tl.recorded_by']),
      ]);
      const rows = ctx.db.prepare(
        `SELECT tl.* FROM fssai_temperature_logs tl ${w.sql}
          ORDER BY tl.business_date DESC, tl.reading_at DESC LIMIT ?`,
      ).all(...w.args, lim(ctx) + 1) as any[];
      const truncated = rows.length > lim(ctx);
      const page = truncated ? rows.slice(0, lim(ctx)) : rows;
      let fails = 0; let unjudged = 0;
      const cells = page.map((r) => {
        if (intOr(r.is_judged, 1) === 0) unjudged++;
        else if (intOr(r.is_fail) === 1) fails++;
        const range: string[] = [];
        if (r.min_used !== null && r.min_used !== undefined) range.push(`≥ ${numOrBlank(r.min_used, 1)}`);
        if (r.max_used !== null && r.max_used !== undefined) range.push(`≤ ${numOrBlank(r.max_used, 1)}`);
        return [
          String(r.business_date || ''),
          String(r.reading_at || ''),
          fssaiTempLogKindLabel(r.log_kind),
          String(r.equipment_label || r.area_label || ''),
          String(r.item_label || ''),
          numOrBlank(r.value_num, intOr(r.decimals, 1)),
          String(r.uom || ''),
          range.length ? range.join(' and ') : 'none set',
          minutesWords(r),
          tempVerdictWord(r),
          String(r.action_taken || ''),
          String(r.recorded_name || r.recorded_by || ''),
          fssaiRecordStatusMeta(r.status).label,
        ];
      });
      return {
        cells,
        truncated,
        kpis: [
          { label: 'Readings', value: String(page.length) },
          { label: 'Out of range', value: String(fails) },
          { label: 'No range set', value: String(unjudged), sub: 'recorded but not judged' },
        ],
        note:
          'The range shown is the one that WAS APPLIED when the reading was taken, frozen on the record. ' +
          '"No range set" is not a pass — it means the reading exists and nothing judged it. ' +
          'For cooling and reheating, "Minutes" is counted from the batch\'s first reading against the time allowed, ' +
          'and "On schedule" means the food had not reached the target yet but was where it needed to be by then — ' +
          'see the Cooling and reheating sheet for each batch reading by reading.',
      };
    },
  },

  /* ── 8. only the breaches ──────────────────────────────────────────────── */
  {
    key: 'temperature-breaches',
    label: 'Temperature breaches',
    group: 'Temperature',
    blurb: 'Only the readings that were out of range, with what was done about each one.',
    requires: ['fssai_temperature_logs'],
    dateLabel: 'the day the reading belongs to',
    hasDepartment: true,
    columns: [
      { key: 'business_date', label: 'Date', width: 1 },
      { key: 'reading_at', label: 'Time', width: 1 },
      { key: 'where', label: 'Where', width: 1.8 },
      { key: 'kind', label: 'What', width: 1.4 },
      { key: 'value', label: 'Reading', align: 'right', width: 0.9 },
      { key: 'range', label: 'Should have been', width: 1.4 },
      { key: 'why', label: 'Why it failed', width: 1.8 },
      { key: 'action', label: 'Action taken', width: 2 },
      { key: 'by', label: 'By', width: 1.3, secondary: true },
    ],
    run(ctx) {
      const w = whereAll([
        { sql: `tl.is_fail = 1 AND tl.status <> 'void'`, args: [] },
        dateClause('tl.business_date', ctx.window),
        deptFilter(ctx, 'tl'),
      ]);
      const rows = ctx.db.prepare(
        `SELECT tl.* FROM fssai_temperature_logs tl ${w.sql}
          ORDER BY tl.business_date DESC, tl.reading_at DESC LIMIT ?`,
      ).all(...w.args, lim(ctx) + 1) as any[];
      const truncated = rows.length > lim(ctx);
      const page = truncated ? rows.slice(0, lim(ctx)) : rows;
      let noAction = 0;
      const cells = page.map((r) => {
        if (!String(r.action_taken || '').trim()) noAction++;
        const range: string[] = [];
        if (r.min_used !== null && r.min_used !== undefined) range.push(`≥ ${numOrBlank(r.min_used, 1)}`);
        if (r.max_used !== null && r.max_used !== undefined) range.push(`≤ ${numOrBlank(r.max_used, 1)}`);
        return [
          String(r.business_date || ''),
          String(r.reading_at || ''),
          String(r.equipment_label || r.area_label || ''),
          fssaiTempLogKindLabel(r.log_kind),
          `${numOrBlank(r.value_num, intOr(r.decimals, 1))} ${String(r.uom || '')}`.trim(),
          range.join(' and '),
          String(r.fail_reason || ''),
          String(r.action_taken || ''),
          String(r.recorded_name || r.recorded_by || ''),
        ];
      });
      return {
        cells,
        truncated,
        kpis: [
          { label: 'Breaches', value: String(page.length) },
          { label: 'With nothing recorded as done', value: String(noAction) },
        ],
        note: 'Voided readings are excluded from this one report, because a breach that was entered in error is not a breach.',
      };
    },
  },

  /* ── 8b. the cooling (and reheating) monitoring sheet ─────────────────── */
  {
    key: 'cooling-sheet',
    label: 'Cooling and reheating sheet',
    group: 'Temperature',
    blurb: 'Each batch cooled or reheated, reading by reading: when it started and at what temperature, the minutes counted for each reading, where it needed to be by then, and whether it reached the target in time.',
    requires: ['fssai_temperature_logs'],
    dateLabel: 'the day the reading belongs to',
    hasDepartment: true,
    columns: [
      { key: 'batch', label: 'Batch', width: 1.8 },
      { key: 'kind', label: 'What', width: 0.9 },
      { key: 'started', label: 'Started', width: 1.5 },
      { key: 'business_date', label: 'Date', width: 0.9, secondary: true },
      { key: 'reading_at', label: 'Time', width: 0.7 },
      { key: 'minutes', label: 'Minutes', align: 'right', width: 0.8 },
      { key: 'value', label: 'Reading', align: 'right', width: 0.8 },
      { key: 'needed', label: 'Needed by then', align: 'right', width: 1 },
      { key: 'rule', label: 'Rule', width: 1.4 },
      { key: 'verdict', label: 'Verdict', width: 1 },
      { key: 'outcome', label: 'Batch outcome', width: 1.7 },
      { key: 'detail', label: 'Why / action taken', width: 2, secondary: true },
      { key: 'by', label: 'By', width: 1.2, secondary: true },
      { key: 'status', label: 'Status', width: 0.8 },
    ],
    run(ctx) {
      const kinds = FSSAI_TEMP_LOG_KINDS.filter((k) => k.window_minutes).map((k) => k.key);
      const w = whereAll([
        { sql: `tl.log_kind IN (${kinds.map(() => '?').join(',')})`, args: kinds },
        dateClause('tl.business_date', ctx.window),
        deptFilter(ctx, 'tl'),
        statusFilter(ctx, 'tl'),
        textFilter(ctx, ['tl.equipment_label', 'tl.area_label', 'tl.item_label', 'tl.recorded_by']),
      ]);
      const rows = ctx.db.prepare(
        `SELECT tl.* FROM fssai_temperature_logs tl ${w.sql}
          ORDER BY tl.business_date DESC, tl.reading_at DESC LIMIT ?`,
      ).all(...w.args, lim(ctx) + 1) as any[];
      const truncated = rows.length > lim(ctx);
      const page = truncated ? rows.slice(0, lim(ctx)) : rows;

      /* ONE BATCH = ONE CURVE. Its key is batch_id, or the reading's own id for a
       * batch's first reading (see resolveFssaiCurve). The start, the outcome and
       * the schedule are read from the WHOLE batch, not just the rows inside the
       * date window, so a batch that began late last night still shows where it
       * started. Each reading's verdict is its own frozen one. */
      interface Batch {
        key: string; kind: string; members: FssaiCurveMember[]; start: FssaiCurveMember | null;
        rows: any[]; outcome: string; firstMinute: string;
      }
      const batches = new Map<string, Batch>();
      const nowMinute = fssaiNowMinuteIST();
      for (const r of page) {
        const kind = String(r.log_kind || '');
        const key = String(r.batch_id || '') || String(r.id);
        const id = `${kind}|${key}`;
        let b = batches.get(id);
        if (!b) {
          const members = fssaiCurveMembers(ctx.db, kind, key, true);
          const live = members.filter((m) => m.status !== 'void');
          const start = live[0] || null;
          /* THE BATCH'S RULE (fssaiCurveRule), the one the screen's summary and
           * both overdue jobs judge it on — not its first reading's (closing
           * round 2, 2026-10-15). Read off the first reading only, a batch begun
           * before cooling was switched on had no limit and no target here: its
           * 4 °C read "no reading at the target" while the screen said "reached
           * in time" and the job raised nothing. */
          const rule = fssaiCurveRule(ctx.db, kind, live);
          const reached = fssaiCurveReached(live, kind, rule.goal);
          const breach = live.some((m) => m.is_fail === 1);
          const limit = rule.limit;
          const lastLive = live[live.length - 1] || null;
          /* Past its time with nothing at the target, on the batch's own clock —
           * the same sum fssaiCurveSummary does for the screen. */
          const elapsedNow = start && start.minute !== null && nowMinute !== null
            ? (start.elapsed ?? 0) + (nowMinute - start.minute) : null;
          const overdue = limit !== null && elapsedNow !== null && elapsedNow > limit;
          const outcome = breach
            ? 'Breach recorded on this batch'
            : reached
              ? (limit !== null && reached.elapsed !== null && reached.elapsed > limit
                ? `Reached ${numOrBlank(reached.value, 1)} at ${reached.elapsed} min — AFTER the ${limit} allowed`
                : `Reached ${numOrBlank(reached.value, 1)} at ${reached.elapsed ?? '?'} min — in time`)
              : (lastLive
                ? `Not finished — last ${numOrBlank(lastLive.value, 1)} at ${lastLive.elapsed ?? '?'} min, no reading at the target${overdue ? `, and the ${limit} minutes allowed have run out` : ''}`
                : 'Every reading voided');
          b = {
            key, kind, members, start, rows: [], outcome,
            firstMinute: start ? `${start.business_date} ${start.reading_at}` : `${String(r.business_date || '')} ${String(r.reading_at || '')}`,
          };
          batches.set(id, b);
        }
        b.rows.push(r);
      }

      const ordered = Array.from(batches.values()).sort((a, b) => b.firstMinute.localeCompare(a.firstMinute));
      let inTime = 0; let breaches = 0; let unfinished = 0;
      const cells: Array<Array<string | number>> = [];
      for (const b of ordered) {
        if (b.outcome.startsWith('Breach')) breaches++;
        else if (b.outcome.startsWith('Reached') && b.outcome.endsWith('in time')) inTime++;
        else if (b.outcome.startsWith('Not finished')) unfinished++;
        const dir = fssaiTempDirection(b.kind);
        const order = new Map(b.members.map((m, i) => [m.id, i]));
        b.rows.sort((x, y) => (order.get(String(x.id)) ?? 0) - (order.get(String(y.id)) ?? 0));
        for (const r of b.rows) {
          const uom = String(r.uom || 'C');
          const u = uom === 'C' || uom === 'F' ? ` °${uom}` : ` ${uom}`;
          const m = b.members.find((x) => x.id === String(r.id)) || null;
          /* "Needed by then" from THIS reading's frozen line (curve_start_*), so
           * the sheet draws the line the verdict actually used. Rows filed before
           * the line was frozen fall back to the batch's first live reading, which
           * is what their verdicts were measured from. */
          const expected = m && String(r.status) !== 'void'
            ? fssaiReadingScheduleValue(r, b.start ? { value: b.start.value, elapsed: b.start.elapsed } : null)
            : null;
          const side = dir === 'hot' ? '≥' : '≤';
          const ruleGoal = numOrNull(r.target_used) ?? (dir === 'hot' ? numOrNull(r.min_used) : numOrNull(r.max_used));
          const ruleLimit = intOrBlank(r.max_minutes_used);
          /* A batch with no 0-minute reading was measured from the rule's
           * starting temperature, and the sheet says so on every row of it. */
          const anchored = String(r.curve_start_source || '') === 'standard_anchor' && numOrNull(r.curve_start_used) !== null;
          cells.push([
            [String(r.item_label || ''), String(r.equipment_label || r.area_label || '')].filter(Boolean).join(' · ') || 'Unnamed',
            fssaiTempLogKindLabel(r.log_kind),
            (b.start
              ? `${b.start.business_date !== String(r.business_date || '') ? `${b.start.business_date} ` : ''}${b.start.reading_at} at ${numOrBlank(b.start.value, 1)}${u}${(b.start.elapsed ?? 0) > 0 ? ` (${b.start.elapsed} min in)` : ''}`
              : '')
              + (anchored ? ` — no 0-minute reading; measured from the rule's ${numOrBlank(r.curve_start_used, 1)}${u} at 0 min` : ''),
            String(r.business_date || ''),
            String(r.reading_at || ''),
            intOrBlank(r.elapsed_minutes),
            numOrBlank(r.value_num, intOr(r.decimals, 1)),
            expected === null ? '' : `${side} ${fssaiCurveExpectedShown(expected, dir)}`,
            ruleGoal === null ? 'none set' : `${side} ${numOrBlank(ruleGoal, 1)}${u}${ruleLimit ? ` within ${ruleLimit} min` : ''}`,
            tempVerdictWord(r),
            b.outcome,
            [String(r.fail_reason || ''), String(r.action_taken || '') ? `Done: ${String(r.action_taken)}` : ''].filter(Boolean).join(' '),
            String(r.recorded_name || r.recorded_by || ''),
            fssaiRecordStatusMeta(r.status).label,
          ]);
        }
      }
      return {
        cells,
        truncated,
        kpis: [
          { label: 'Batches', value: String(ordered.length) },
          { label: 'Reached the target in time', value: String(inTime) },
          { label: 'With a breach', value: String(breaches) },
          { label: 'Not finished', value: String(unfinished), sub: 'no reading at the target' },
        ],
        note:
          'One block per batch, readings in the order they were taken. "Minutes" is counted by the system from the batch\'s first reading, not typed. ' +
          '"Needed by then" is where the batch had to be at that point — a straight line from where it started at 0 minutes (its own 0-minute reading, ' +
          'or the rule\'s starting temperature when it had none) to the target at the time allowed; a batch with neither had no line, and a reading short of the target on it was failed; ' +
          '"On schedule" means short of the target but where it needed to be. Each verdict is the one frozen on the reading when it was taken. ' +
          '"Not finished" means no reading at the target was ever recorded.',
      };
    },
  },

  /* ── 9. equipment events ───────────────────────────────────────────────── */
  {
    key: 'equipment-events',
    label: 'Equipment, calibration and breakdowns',
    group: 'Temperature',
    blurb: 'Calibrations, services, breakdowns and defrosts against each cold unit, with what is due next.',
    requires: ['fssai_equipment_events'],
    dateLabel: 'the day of the event',
    hasDepartment: true,
    columns: [
      { key: 'business_date', label: 'Date', width: 1 },
      { key: 'equipment', label: 'Equipment', width: 2 },
      { key: 'kind', label: 'Event', width: 1.4 },
      { key: 'detail', label: 'Detail', width: 2.4 },
      { key: 'before', label: 'Before', align: 'right', width: 0.8, secondary: true },
      { key: 'reference', label: 'Reference', align: 'right', width: 0.9, secondary: true },
      { key: 'after', label: 'After', align: 'right', width: 0.8, secondary: true },
      { key: 'deviation', label: 'Deviation', align: 'right', width: 0.9 },
      { key: 'downtime', label: 'Downtime (min)', align: 'right', width: 1.1, secondary: true },
      { key: 'next_due', label: 'Next due', width: 1 },
      { key: 'by', label: 'By', width: 1.2, secondary: true },
    ],
    run(ctx) {
      const w = whereAll([
        dateClause('e.business_date', ctx.window),
        deptFilter(ctx, 'e'),
        statusFilter(ctx, 'e'),
        textFilter(ctx, ['e.equipment_label', 'e.detail', 'e.reference_no', 'e.performed_by']),
      ]);
      const rows = ctx.db.prepare(
        `SELECT e.* FROM fssai_equipment_events e ${w.sql}
          ORDER BY e.business_date DESC, e.event_at DESC LIMIT ?`,
      ).all(...w.args, lim(ctx) + 1) as any[];
      const truncated = rows.length > lim(ctx);
      const page = truncated ? rows.slice(0, lim(ctx)) : rows;
      const overdue = page.filter((r) => String(r.next_due_date || '') && String(r.next_due_date) < ctx.today).length;
      const cells = page.map((r) => [
        String(r.business_date || ''),
        String(r.equipment_label || ''),
        String(r.event_kind || ''),
        String(r.detail || ''),
        numOrBlank(r.value_before, 1),
        numOrBlank(r.reference_value, 1),
        numOrBlank(r.value_after, 1),
        numOrBlank(r.deviation, 2),
        intOrBlank(r.downtime_minutes),
        String(r.next_due_date || ''),
        String(r.performed_by || ''),
      ]);
      return {
        cells,
        truncated,
        kpis: [
          { label: 'Events', value: String(page.length) },
          { label: 'Next date already past', value: String(overdue) },
        ],
        note: 'A blank "before/reference/after" means the event did not involve a measurement, not that it read 0.',
      };
    },
  },

  /* ── 10. expiry and disposal ───────────────────────────────────────────── */
  {
    key: 'expiry-disposals',
    label: 'Expiry and disposal register',
    group: 'Stock',
    blurb: 'Everything found near or past its date, what was done with it, and who witnessed a disposal.',
    requires: ['fssai_expiry_items'],
    dateLabel: 'the day it was found',
    hasDepartment: true,
    columns: [
      { key: 'business_date', label: 'Found', width: 1 },
      { key: 'material', label: 'Item', width: 2.2 },
      { key: 'batch', label: 'Batch / lot', width: 1.4, secondary: true },
      { key: 'where', label: 'Where', width: 1.4, secondary: true },
      { key: 'expiry', label: 'Expiry', width: 1 },
      { key: 'days', label: 'Days', align: 'right', width: 0.7 },
      { key: 'state', label: 'State', width: 1.1 },
      { key: 'qty', label: 'Qty', align: 'right', width: 0.8 },
      { key: 'uom', label: 'Unit', width: 0.7 },
      { key: 'action', label: 'Action', width: 1.4 },
      { key: 'discarded', label: 'Discarded', align: 'right', width: 1 },
      { key: 'method', label: 'How', width: 1.2, secondary: true },
      { key: 'witness', label: 'Witnessed by', width: 1.3, secondary: true },
    ],
    run(ctx) {
      const w = whereAll([
        dateClause('x.business_date', ctx.window),
        deptFilter(ctx, 'x'),
        statusFilter(ctx, 'x'),
        textFilter(ctx, ['x.material_name', 'x.batch_label', 'x.lot_no', 'x.location_label']),
      ]);
      const rows = ctx.db.prepare(
        `SELECT x.* FROM fssai_expiry_items x ${w.sql}
          ORDER BY x.business_date DESC, x.expiry_date ASC LIMIT ?`,
      ).all(...w.args, lim(ctx) + 1) as any[];
      const truncated = rows.length > lim(ctx);
      const page = truncated ? rows.slice(0, lim(ctx)) : rows;
      const cells = page.map((r) => [
        String(r.business_date || ''),
        String(r.material_name || ''),
        [String(r.batch_label || ''), String(r.lot_no || '')].filter(Boolean).join(' / '),
        String(r.location_label || ''),
        String(r.expiry_date || ''),
        intOrBlank(r.days_to_expiry),
        fssaiExpiryStateMeta(r.state).label,
        numOrBlank(r.qty, 3),
        String(r.uom || ''),
        String(r.action_taken || ''),
        numOrBlank(r.discard_qty, 3),
        String(r.discard_method || ''),
        String(r.witnessed_by || ''),
      ]);
      return {
        cells,
        truncated,
        kpis: [
          { label: 'Entries', value: String(page.length) },
          { label: 'Past their date', value: String(page.filter((r) => String(r.state) === 'expired').length) },
        ],
        note:
          'Recording a disposal here does NOT move stock. This module observes and records; the stock ledger is adjusted ' +
          'in the store screens, deliberately, so one entry can never silently become two movements.',
      };
    },
  },

  /* ── 11. oil quality ──────────────────────────────────────────────────── */
  {
    key: 'oil-checks',
    label: 'Fryer oil checks',
    group: 'Oil, water and pests',
    blurb: 'Every oil check — meter reading, look and smell, and whether the oil was changed.',
    requires: ['fssai_oil_checks'],
    dateLabel: 'the day of the check',
    hasDepartment: true,
    columns: [
      { key: 'business_date', label: 'Date', width: 1 },
      { key: 'equipment', label: 'Fryer', width: 1.6 },
      { key: 'oil_type', label: 'Oil', width: 1.1, secondary: true },
      { key: 'method', label: 'Method', width: 1.1, secondary: true },
      { key: 'tpm', label: 'TPM %', align: 'right', width: 0.8 },
      { key: 'limit', label: 'Limit %', align: 'right', width: 0.8 },
      { key: 'ffa', label: 'FFA %', align: 'right', width: 0.8, secondary: true },
      { key: 'temp', label: '°C', align: 'right', width: 0.7, secondary: true },
      { key: 'smell', label: 'Smell', width: 1, secondary: true },
      { key: 'foaming', label: 'Foaming', width: 1, secondary: true },
      { key: 'verdict', label: 'Verdict', width: 1 },
      { key: 'changed', label: 'Changed', width: 0.9 },
      { key: 'discarded', label: 'Discarded', align: 'right', width: 1 },
      { key: 'by', label: 'By', width: 1.2, secondary: true },
    ],
    run(ctx) {
      const w = whereAll([
        dateClause('o.business_date', ctx.window),
        deptFilter(ctx, 'o'),
        statusFilter(ctx, 'o'),
        textFilter(ctx, ['o.equipment_label', 'o.oil_type', 'o.recorded_by']),
      ]);
      const rows = ctx.db.prepare(
        `SELECT o.* FROM fssai_oil_checks o ${w.sql}
          ORDER BY o.business_date DESC, o.checked_at DESC LIMIT ?`,
      ).all(...w.args, lim(ctx) + 1) as any[];
      const truncated = rows.length > lim(ctx);
      const page = truncated ? rows.slice(0, lim(ctx)) : rows;
      const cells = page.map((r) => [
        String(r.business_date || ''),
        String(r.equipment_label || ''),
        String(r.oil_type || ''),
        String(r.method || ''),
        numOrBlank(r.tpm_pct, 1),
        numOrBlank(r.max_tpm_used, 1),
        numOrBlank(r.ffa_pct, 2),
        numOrBlank(r.temp_c, 1),
        fssaiCheckResultLabel(r.chk_smell),
        fssaiCheckResultLabel(r.chk_foaming),
        verdictWord(r.is_fail, r.is_judged),
        intOr(r.oil_changed) === 1 ? 'Yes' : '',
        numOrBlank(r.qty_discarded, 2),
        String(r.recorded_name || r.recorded_by || ''),
      ]);
      return {
        cells,
        truncated,
        kpis: [
          { label: 'Checks', value: String(page.length) },
          { label: 'Over the limit', value: String(page.filter((r) => intOr(r.is_fail) === 1).length) },
          { label: 'Oil changed', value: String(page.filter((r) => intOr(r.oil_changed) === 1).length) },
        ],
        note:
          'The limit shown is the one that was applied at the time, read off the record — not today’s setting. ' +
          '"Not checked" against smell or foaming means nobody assessed it, which is different from assessing it as fine.',
      };
    },
  },

  /* ── 12. used-oil collection ───────────────────────────────────────────── */
  {
    key: 'oil-disposals',
    label: 'Used-oil collections',
    group: 'Oil, water and pests',
    blurb: 'Who collected the used oil, under which registration, how much, and against which receipt.',
    requires: ['fssai_oil_disposals'],
    dateLabel: 'the day of collection',
    hasDepartment: false,
    columns: [
      { key: 'business_date', label: 'Date', width: 1 },
      { key: 'collector', label: 'Collector', width: 2 },
      { key: 'reg', label: 'Agency registration', width: 1.6 },
      { key: 'vehicle', label: 'Vehicle', width: 1.1 },
      { key: 'qty', label: 'Quantity', align: 'right', width: 1 },
      { key: 'uom', label: 'Unit', width: 0.7 },
      { key: 'receipt', label: 'Receipt no.', width: 1.2 },
      { key: 'handed', label: 'Handed over by', width: 1.4 },
      { key: 'status', label: 'Status', width: 1 },
    ],
    run(ctx) {
      const w = whereAll([
        dateClause('d.business_date', ctx.window),
        statusFilter(ctx, 'd'),
        textFilter(ctx, ['d.collector_name', 'd.agency_reg_no', 'd.receipt_no', 'd.vehicle_no']),
      ]);
      const rows = ctx.db.prepare(
        `SELECT d.* FROM fssai_oil_disposals d ${w.sql}
          ORDER BY d.business_date DESC LIMIT ?`,
      ).all(...w.args, lim(ctx) + 1) as any[];
      const truncated = rows.length > lim(ctx);
      const page = truncated ? rows.slice(0, lim(ctx)) : rows;
      const cells = page.map((r) => [
        String(r.business_date || ''),
        String(r.collector_name || ''),
        String(r.agency_reg_no || ''),
        String(r.vehicle_no || ''),
        numOrBlank(r.quantity, 2),
        String(r.uom || ''),
        String(r.receipt_no || ''),
        String(r.handed_over_by || ''),
        fssaiRecordStatusMeta(r.status).label,
      ]);
      return {
        cells,
        truncated,
        note:
          'There is deliberately no money column on a used-oil collection. What the collector pays is income, and it ' +
          'belongs in the books once, not in a food-safety register as well.',
      };
    },
  },

  /* ── 13. water and ice ────────────────────────────────────────────────── */
  {
    key: 'water-tests',
    label: 'Water and ice tests',
    group: 'Oil, water and pests',
    blurb: 'Daily checks and laboratory certificates, with the result and when the next one is due.',
    requires: ['fssai_water_tests'],
    dateLabel: 'the day of the test',
    hasDepartment: true,
    columns: [
      { key: 'business_date', label: 'Date', width: 1 },
      { key: 'kind', label: 'Test', width: 1.8 },
      { key: 'source', label: 'Point', width: 1.4 },
      { key: 'value', label: 'Reading', align: 'right', width: 0.9 },
      { key: 'uom', label: 'Unit', width: 0.7 },
      { key: 'range', label: 'Range applied', width: 1.2 },
      { key: 'verdict', label: 'Verdict', width: 1 },
      { key: 'lab', label: 'Laboratory', width: 1.6, secondary: true },
      { key: 'report', label: 'Report no.', width: 1.1, secondary: true },
      { key: 'next_due', label: 'Next due', width: 1 },
      { key: 'by', label: 'By', width: 1.2, secondary: true },
    ],
    run(ctx) {
      const w = whereAll([
        dateClause('t.business_date', ctx.window),
        deptFilter(ctx, 't'),
        statusFilter(ctx, 't'),
        textFilter(ctx, ['t.source_point', 't.lab_name', 't.report_no', 't.recorded_by']),
      ]);
      const rows = ctx.db.prepare(
        `SELECT t.* FROM fssai_water_tests t ${w.sql}
          ORDER BY t.business_date DESC, t.tested_at DESC LIMIT ?`,
      ).all(...w.args, lim(ctx) + 1) as any[];
      const truncated = rows.length > lim(ctx);
      const page = truncated ? rows.slice(0, lim(ctx)) : rows;
      const cells = page.map((r) => {
        const range: string[] = [];
        if (r.min_used !== null && r.min_used !== undefined) range.push(`≥ ${numOrBlank(r.min_used, 2)}`);
        if (r.max_used !== null && r.max_used !== undefined) range.push(`≤ ${numOrBlank(r.max_used, 2)}`);
        return [
          String(r.business_date || ''),
          fssaiWaterTestKind(r.test_kind)?.label || String(r.test_kind || ''),
          String(r.source_point || ''),
          numOrBlank(r.value_num, intOr(r.decimals, 2)),
          String(r.uom || ''),
          range.join(' and '),
          String(r.result || '') || verdictWord(r.is_fail, r.is_judged),
          String(r.lab_name || ''),
          String(r.report_no || ''),
          String(r.next_due_date || ''),
          String(r.recorded_name || r.recorded_by || ''),
        ];
      });
      const labRows = page.filter((r) => String(r.lab_name || '') || String(r.report_no || ''));
      return {
        cells,
        truncated,
        kpis: [
          { label: 'Tests', value: String(page.length) },
          { label: 'Laboratory certificates', value: String(labRows.length) },
          { label: 'Failed', value: String(page.filter((r) => intOr(r.is_fail) === 1).length) },
        ],
        note: 'A laboratory certificate’s individual parameters are held on the record itself; this table shows the headline result.',
      };
    },
  },

  /* ── 14. pest control visits ───────────────────────────────────────────── */
  {
    key: 'pest-services',
    label: 'Pest control visits',
    group: 'Oil, water and pests',
    blurb: 'Contracted visits — who came, what they treated, what they found, and when the next one is due.',
    requires: ['fssai_pest_services'],
    dateLabel: 'the day of the visit',
    hasDepartment: false,
    columns: [
      { key: 'business_date', label: 'Date', width: 1 },
      { key: 'service_no', label: 'Visit no.', width: 1 },
      { key: 'vendor', label: 'Agency', width: 1.8 },
      { key: 'licence', label: 'Licence', width: 1.2, secondary: true },
      { key: 'technician', label: 'Technician', width: 1.3, secondary: true },
      { key: 'kind', label: 'Treatment', width: 1.2 },
      { key: 'areas', label: 'Areas covered', width: 2 },
      { key: 'findings', label: 'Findings', width: 2.2 },
      { key: 'next_due', label: 'Next due', width: 1 },
      { key: 'witness', label: 'Our witness', width: 1.3, secondary: true },
      { key: 'status', label: 'Status', width: 1.1 },
    ],
    run(ctx) {
      const w = whereAll([
        dateClause('s.business_date', ctx.window),
        statusFilter(ctx, 's'),
        textFilter(ctx, ['s.vendor_name', 's.technician_name', 's.areas_covered', 's.findings', 's.service_no']),
      ]);
      const rows = ctx.db.prepare(
        `SELECT s.* FROM fssai_pest_services s ${w.sql}
          ORDER BY s.business_date DESC LIMIT ?`,
      ).all(...w.args, lim(ctx) + 1) as any[];
      const truncated = rows.length > lim(ctx);
      const page = truncated ? rows.slice(0, lim(ctx)) : rows;
      const missed = page.filter((r) => String(r.status) === 'missed').length;
      const cells = page.map((r) => [
        String(r.business_date || ''),
        String(r.service_no || ''),
        String(r.vendor_name || ''),
        String(r.agency_licence_no || ''),
        String(r.technician_name || ''),
        String(r.service_kind || ''),
        String(r.areas_covered || ''),
        String(r.findings || ''),
        String(r.next_due_date || ''),
        String(r.staff_witness || ''),
        fssaiPestServiceStatusMeta(r.status).label,
      ]);
      return {
        cells,
        truncated,
        kpis: [
          { label: 'Visits', value: String(page.length) },
          { label: 'Contracted visits missed', value: String(missed) },
        ],
        note:
          'A contracted visit that did not happen is kept as a MISSED row rather than deleted — it is the commonest ' +
          'finding at an inspection, and a gap with no row looks the same as a gap nobody noticed.',
      };
    },
  },

  /* ── 15. sightings ────────────────────────────────────────────────────── */
  {
    key: 'pest-sightings',
    label: 'Pest sightings',
    group: 'Oil, water and pests',
    blurb: 'What your own staff reported between visits, where, and what was done immediately.',
    requires: ['fssai_pest_sightings'],
    dateLabel: 'the day of the sighting',
    hasDepartment: true,
    columns: [
      { key: 'business_date', label: 'Date', width: 1 },
      { key: 'pest', label: 'Pest', width: 1.2 },
      { key: 'evidence', label: 'Evidence', width: 1.2 },
      { key: 'count', label: 'Seen', align: 'right', width: 0.7 },
      { key: 'severity', label: 'Severity', width: 1 },
      { key: 'where', label: 'Where', width: 1.8 },
      { key: 'description', label: 'Description', width: 2.4 },
      { key: 'action', label: 'Immediate action', width: 2 },
      { key: 'by', label: 'Reported by', width: 1.3, secondary: true },
      { key: 'status', label: 'Status', width: 1 },
    ],
    run(ctx) {
      const w = whereAll([
        dateClause('g.business_date', ctx.window),
        deptFilter(ctx, 'g'),
        statusFilter(ctx, 'g'),
        textFilter(ctx, ['g.location_label', 'g.description', 'g.reported_by', 'g.pest_type']),
      ]);
      const rows = ctx.db.prepare(
        `SELECT g.* FROM fssai_pest_sightings g ${w.sql}
          ORDER BY g.business_date DESC, g.sighted_at DESC LIMIT ?`,
      ).all(...w.args, lim(ctx) + 1) as any[];
      const truncated = rows.length > lim(ctx);
      const page = truncated ? rows.slice(0, lim(ctx)) : rows;
      const cells = page.map((r) => [
        String(r.business_date || ''),
        String(r.pest_type || ''),
        String(r.evidence_kind || ''),
        intOrBlank(r.count_seen),
        fssaiPestSeverityMeta(r.severity).label,
        String(r.location_label || ''),
        String(r.description || ''),
        String(r.immediate_action || ''),
        String(r.reported_name || r.reported_by || ''),
        String(r.status || ''),
      ]);
      return {
        cells,
        truncated,
        kpis: [
          { label: 'Sightings', value: String(page.length) },
          { label: 'Still open', value: String(page.filter((r) => !String(r.closed_at || '')).length) },
        ],
        note: 'A blank "Seen" means nobody counted — not that nothing was seen. The evidence column says what was observed.',
      };
    },
  },

  /* ── 16. documents and certificates ───────────────────────────────────── */
  {
    key: 'documents-expiry',
    label: 'Documents and certificates',
    group: 'The file',
    blurb: 'Every licence and certificate with the state worked out against today — valid, expiring, or expired.',
    requires: ['fssai_documents', 'fssai_food_handlers'],
    dateLabel: 'the expiry date',
    hasDepartment: true,
    columns: [
      { key: 'type', label: 'Type', width: 1.8 },
      { key: 'title', label: 'Document', width: 2.4 },
      { key: 'reference', label: 'Number', width: 1.4 },
      { key: 'issuer', label: 'Issued by', width: 1.6, secondary: true },
      { key: 'belongs', label: 'Belongs to', width: 1.6, secondary: true },
      { key: 'issued', label: 'Issued', width: 1, secondary: true },
      { key: 'expiry', label: 'Expires', width: 1 },
      { key: 'days', label: 'Days left', align: 'right', width: 0.9 },
      { key: 'state', label: 'State', width: 1.1 },
      { key: 'copy', label: 'Copy', width: 0.9 },
      { key: 'owner', label: 'Who renews it', width: 1.6 },
    ],
    run(ctx) {
      /* THE STATE IS DERIVED HERE AND NOWHERE ELSE. It is not a column, because
       * a stored 'expiring' goes stale at midnight with nothing to wake it, and
       * a licence rendering "Valid" the day after it lapsed is the worst single
       * row this module could print. fssaiDocState() is the one definition. */
      const w = whereAll([
        dateClause('d.expiry_date', ctx.window),
        deptFilter(ctx, 'd'),
        statusFilter(ctx, 'd'),
        textFilter(ctx, ['d.title', 'd.reference_no', 'd.issuer', 'd.owner_email', 'd.person_email', 'v.name', 'fh.full_name']),
      ]);
      /* The supplier's NAME, joined — the column used to print the raw vendor_id
       * UUID, which tells an inspector nothing about whose licence it is. The food
       * handler's name likewise (handler_id, 2026-10-14): a certificate for a cook
       * with no app login has no person_email, and would otherwise belong to
       * nobody on this sheet. */
      /* THE COPY — counted the audit file's way (audit-file/lib readScans): a
       * LIVE scan only. A voided scan (attached by mistake — kept, with who, when
       * and why) is never a copy, nor an image an earlier build blanked; a
       * document whose only scan was voided reads "voided only". */
      const hasAtt = fssaiTablesPresent(ctx.db).has('fssai_attachments');
      const copySql = hasAtt
        ? `(SELECT COUNT(*) FROM fssai_attachments a WHERE a.entity_table = 'fssai_documents' AND a.entity_id = d.id
              AND a.data_uri <> '' AND a.status <> 'void' AND a.voided_at = '') AS live_copies,
           (SELECT COUNT(*) FROM fssai_attachments a WHERE a.entity_table = 'fssai_documents' AND a.entity_id = d.id
              AND (a.status = 'void' OR a.voided_at <> '')) AS voided_copies`
        : `0 AS live_copies, 0 AS voided_copies`;
      const rows = ctx.db.prepare(
        `SELECT d.*, IFNULL(v.name, '') AS vendor_name, IFNULL(fh.full_name, '') AS handler_name, ${copySql}
           FROM fssai_documents d
           LEFT JOIN vendors v ON v.id = d.vendor_id
           LEFT JOIN fssai_food_handlers fh ON fh.id = d.handler_id AND d.handler_id <> '' ${w.sql}
          ORDER BY (CASE WHEN d.expiry_date = '' THEN 1 ELSE 0 END) ASC, d.expiry_date ASC LIMIT ?`,
      ).all(...w.args, lim(ctx) + 1) as any[];
      const truncated = rows.length > lim(ctx);
      const page = truncated ? rows.slice(0, lim(ctx)) : rows;
      let expired = 0; let expiring = 0; let superseded = 0; let voided = 0;
      const cells = page.map((r) => {
        /* A RENEWED OR VOIDED DOCUMENT IS NOT "EXPIRED" (measured 2026-10-14: the
         * licence a renewal replaced printed EXPIRED and counted in the Expired
         * figure, beside its own valid renewal). It stays on the sheet — §19, a
         * record is never hidden — but says what it is, and only a live document's
         * expiry is counted. */
        const isVoid = String(r.status || '') === 'void' || !!String(r.voided_at || '');
        const isSuperseded = !isVoid && Number(r.is_active) === 0;
        const state = fssaiDocState(r.expiry_date, ctx.today, intOr(r.reminder_days, 30));
        /* A paper that stands for a PERIOD and carries no expiry date of its own
         * (a water bill: its quarter; a food lab report: a year) lapses by that
         * period — the same rule the audit file and Inspection Mode hand over by
         * (fssaiPaperInForce). It reads "Lapsed <date>" and counts as expired. */
        const force = fssaiPaperInForce({
          doc_type: String(r.doc_type || ''), expiry_date: String(r.expiry_date || ''), valid_from: String(r.valid_from || ''),
          issued_on: String(r.issued_on || ''), created_on: String(r.created_at || '').slice(0, 10),
        }, state, ctx.today);
        const lapsedByPeriod = state !== 'expired' && !force.in_force;
        if (isVoid) voided++;
        else if (isSuperseded) superseded++;
        else if (state === 'expired' || lapsedByPeriod) expired++;
        else if (state === 'expiring') expiring++;
        const exp = String(r.expiry_date || '');
        const days = exp
          ? String(Math.round((Date.parse(`${exp}T00:00:00Z`) - Date.parse(`${ctx.today}T00:00:00Z`)) / 86400000))
          : '';
        /* A supplier document whose vendor row has gone says so in words rather
         * than falling back to an id nobody can read. */
        const vendor = String(r.vendor_id || '')
          ? (String(r.vendor_name || '').trim() || 'A supplier no longer on the vendor list')
          : '';
        /* The handler's name leads (handler_id is the person key that covers a
         * cook with no login), then the login email, then supplier, then dept. */
        const handler = String(r.handler_id || '')
          ? (String(r.handler_name || '').trim() || 'A food handler no longer on the register')
          : '';
        const belongs = handler || String(r.person_email || '') || vendor || deptName(ctx, r.department_id) || '';
        const stateWords = isVoid
          ? `Voided${String(r.void_reason || '') ? ` — ${String(r.void_reason)}` : ''}`
          : isSuperseded
            ? 'Superseded — renewed'
            : lapsedByPeriod ? force.state_words : fssaiDocStateMeta(state).label;
        const live = intOr(r.live_copies);
        const copy = live ? `${live} scan${live === 1 ? '' : 's'}` : intOr(r.voided_copies) ? 'voided only' : 'none';
        return [
          fssaiDocType(r.doc_type)?.label || String(r.doc_type || ''),
          String(r.title || ''),
          String(r.reference_no || ''),
          String(r.issuer || ''),
          belongs,
          String(r.issued_on || ''),
          exp,
          /* Days left means nothing on a document that no longer counts. */
          isVoid || isSuperseded ? '' : days,
          stateWords,
          copy,
          String(r.owner_email || ''),
        ];
      });
      return {
        cells,
        truncated,
        kpis: [
          { label: 'Documents', value: String(page.length) },
          { label: 'Expired', value: String(expired), sub: 'live documents only, incl. lapsed by period' },
          { label: 'Expiring soon', value: String(expiring) },
          { label: 'Superseded or voided', value: String(superseded + voided), sub: 'kept on file, not counted' },
        ],
        note:
          `The state is worked out against ${ctx.today} every time this is read, never stored — a document cannot read ` +
          '"Valid" the day after it lapsed. A blank expiry means the document does not expire. ' +
          'A document replaced by its renewal reads "Superseded — renewed" and a voided one "Voided": both stay on the sheet ' +
          'and neither is counted as expired. A water bill, water test, waste record or food lab report with no expiry date ' +
          'stands for its period from its date (a quarter for a bill, a year for a lab report) and reads "Lapsed" after it. ' +
          'Copy counts live scans only — a voided scan is kept, never a copy.',
      };
    },
  },

  /* ── 17. corrective actions ───────────────────────────────────────────── */
  {
    key: 'corrective-actions',
    label: 'Corrective actions',
    group: 'The file',
    blurb: 'Every failed check with an owner, a deadline, what was done, and who checked the fix.',
    requires: ['fssai_corrective_actions'],
    dateLabel: 'the day the action was raised',
    hasDepartment: true,
    columns: [
      { key: 'ca_number', label: 'Action', width: 1.2 },
      { key: 'raised', label: 'Raised', width: 1 },
      { key: 'title', label: 'What failed', width: 2.6 },
      { key: 'severity', label: 'Severity', width: 1 },
      { key: 'department', label: 'Department', width: 1.3, secondary: true },
      { key: 'owner', label: 'Owner', width: 1.5 },
      { key: 'due', label: 'Due', width: 1 },
      { key: 'status', label: 'Status', width: 1.1 },
      { key: 'action_taken', label: 'What was done', width: 2.6 },
      { key: 'verified_by', label: 'Checked by', width: 1.4 },
    ],
    run(ctx) {
      const w = whereAll([
        dateClause(`substr(c.created_at, 1, 10)`, ctx.window),
        deptFilter(ctx, 'c'),
        statusFilter(ctx, 'c', 'cancelled'),
        textFilter(ctx, ['c.title', 'c.description', 'c.owner_email', 'c.ca_number', 'c.action_taken']),
      ]);
      const rows = ctx.db.prepare(
        `SELECT c.* FROM fssai_corrective_actions c ${w.sql}
          ORDER BY c.created_at DESC LIMIT ?`,
      ).all(...w.args, lim(ctx) + 1) as any[];
      const truncated = rows.length > lim(ctx);
      const page = truncated ? rows.slice(0, lim(ctx)) : rows;
      const open = page.filter((r) => ['open', 'in_progress'].includes(String(r.status))).length;
      const overdue = page.filter(
        (r) => ['open', 'in_progress'].includes(String(r.status)) && String(r.due_date || '') && String(r.due_date) < ctx.today,
      ).length;
      const cells = page.map((r) => [
        String(r.ca_number || ''),
        String(r.created_at || '').slice(0, 10),
        String(r.title || ''),
        fssaiCaSeverityMeta(r.severity).label,
        deptName(ctx, r.department_id),
        String(r.owner_email || ''),
        String(r.due_date || ''),
        fssaiCaStatusMeta(r.status).label,
        String(r.action_taken || ''),
        String(r.verified_by || ''),
      ]);
      return {
        cells,
        truncated,
        kpis: [
          { label: 'Actions', value: String(page.length) },
          { label: 'Still open', value: String(open) },
          { label: 'Past their deadline', value: String(overdue) },
        ],
        note:
          'A verified action means the fix was done and somebody else checked it. It never means the original check passed ' +
          'after all — the failure stands in the record it came from.',
      };
    },
  },

  /* ── 18. inspections ──────────────────────────────────────────────────── */
  {
    key: 'inspections',
    label: 'Inspections and audits',
    group: 'The file',
    blurb: 'Every visit that happened — who came, the score or grade they gave, and how many points are still open.',
    requires: ['fssai_inspections'],
    dateLabel: 'the day of the visit',
    hasDepartment: true,
    columns: [
      { key: 'business_date', label: 'Date', width: 1 },
      { key: 'inspection_no', label: 'Ref', width: 1.1 },
      { key: 'kind', label: 'Kind', width: 1.4 },
      { key: 'authority', label: 'Authority', width: 1.8 },
      { key: 'inspector', label: 'Inspector', width: 1.6 },
      { key: 'score', label: 'Score', align: 'right', width: 1 },
      { key: 'grade', label: 'Grade', width: 0.8 },
      { key: 'outcome', label: 'Outcome', width: 1 },
      { key: 'findings', label: 'Points', align: 'right', width: 0.8 },
      { key: 'open', label: 'Open', align: 'right', width: 0.7 },
      { key: 'reply_due', label: 'Reply due', width: 1 },
      { key: 'status', label: 'Status', width: 1.1 },
    ],
    run(ctx) {
      const w = whereAll([
        dateClause('i.business_date', ctx.window),
        deptFilter(ctx, 'i'),
        statusFilter(ctx, 'i'),
        textFilter(ctx, ['i.authority', 'i.inspector_name', 'i.inspection_no', 'i.report_no', 'i.scope']),
      ]);
      const rows = ctx.db.prepare(
        `SELECT i.* FROM fssai_inspections i ${w.sql}
          ORDER BY i.business_date DESC LIMIT ?`,
      ).all(...w.args, lim(ctx) + 1) as any[];
      const truncated = rows.length > lim(ctx);
      const page = truncated ? rows.slice(0, lim(ctx)) : rows;
      const cells = page.map((r) => {
        const sc = r.score === null || r.score === undefined ? '' : numOrBlank(r.score, 1);
        const mx = r.score_max === null || r.score_max === undefined ? '' : numOrBlank(r.score_max, 1);
        return [
          String(r.business_date || ''),
          String(r.inspection_no || ''),
          String(r.inspection_kind || ''),
          String(r.authority || ''),
          String(r.inspector_name || ''),
          sc ? (mx ? `${sc} / ${mx}` : sc) : '',
          String(r.grade || ''),
          String(r.outcome || ''),
          intOr(r.finding_count),
          intOr(r.open_count),
          String(r.reply_due_date || ''),
          fssaiInspectionStatusMeta(r.status).label,
        ];
      });
      return {
        cells,
        truncated,
        kpis: [
          { label: 'Visits', value: String(page.length) },
          { label: 'With points still open', value: String(page.filter((r) => intOr(r.open_count) > 0).length) },
        ],
        note: 'The score and grade are theirs, recorded as printed. A blank score means none was given, not zero.',
      };
    },
  },

  /* ── 19. the points they raised ───────────────────────────────────────── */
  {
    key: 'inspection-findings',
    label: 'Inspection findings',
    group: 'The file',
    blurb: 'Point by point: the clause cited, the deadline, and how it was closed.',
    requires: ['fssai_inspections', 'fssai_inspection_findings'],
    dateLabel: 'the day of the visit',
    hasDepartment: true,
    columns: [
      { key: 'business_date', label: 'Visit', width: 1 },
      { key: 'authority', label: 'Authority', width: 1.5 },
      { key: 'finding_no', label: 'No.', width: 0.6 },
      { key: 'clause', label: 'Clause', width: 1.1 },
      { key: 'severity', label: 'Severity', width: 1 },
      { key: 'observation', label: 'Observation', width: 3 },
      { key: 'where', label: 'Where', width: 1.3, secondary: true },
      { key: 'due', label: 'Due', width: 1 },
      { key: 'response', label: 'Our response', width: 2.4 },
      { key: 'status', label: 'Status', width: 1.1 },
      { key: 'closed', label: 'Closed', width: 1, secondary: true },
    ],
    run(ctx) {
      const w = whereAll([
        dateClause('i.business_date', ctx.window),
        deptFilter(ctx, 'f'),
        ctx.status && ctx.status !== 'all'
          ? (ctx.status === 'active' ? { sql: `f.status <> 'closed'`, args: [] } : { sql: `f.status = ?`, args: [ctx.status] })
          : null,
        textFilter(ctx, ['f.observation', 'f.clause_ref', 'f.response', 'i.authority']),
      ]);
      const rows = ctx.db.prepare(
        `SELECT f.*, i.business_date, i.authority, i.inspection_no
           FROM fssai_inspection_findings f
           JOIN fssai_inspections i ON i.id = f.inspection_id
           ${w.sql}
          ORDER BY i.business_date DESC, f.sort_order ASC LIMIT ?`,
      ).all(...w.args, lim(ctx) + 1) as any[];
      const truncated = rows.length > lim(ctx);
      const page = truncated ? rows.slice(0, lim(ctx)) : rows;
      const cells = page.map((r) => [
        String(r.business_date || ''),
        String(r.authority || ''),
        String(r.finding_no || ''),
        String(r.clause_ref || ''),
        fssaiFindingSeverityMeta(r.severity).label,
        String(r.observation || ''),
        String(r.location_label || ''),
        String(r.due_date || ''),
        String(r.response || ''),
        fssaiFindingStatusMeta(r.status).label,
        String(r.closed_at || '').slice(0, 10),
      ]);
      const overdue = page.filter(
        (r) => String(r.status) !== 'closed' && String(r.due_date || '') && String(r.due_date) < ctx.today,
      ).length;
      return {
        cells,
        truncated,
        kpis: [
          { label: 'Points', value: String(page.length) },
          { label: 'Still open', value: String(page.filter((r) => String(r.status) !== 'closed').length) },
          { label: 'Past their deadline', value: String(overdue) },
        ],
        note:
          'A long observation is cut off in the PDF table — the full text of every point is printed underneath it, ' +
          'one paragraph each, because the PDF writer truncates table cells rather than wrapping them.',
      };
    },
  },

  /* ── 20. the change-and-void trail ────────────────────────────────────── */
  {
    key: 'audit-trail',
    label: 'Record changes and voids',
    group: 'The file',
    blurb: 'Who changed a compliance record, what it was before, and the reason given for cancelling one.',
    requires: ['fssai_audit_log'],
    dateLabel: 'the day of the change',
    hasDepartment: false,
    columns: [
      { key: 'created_at', label: 'When', width: 1.4 },
      { key: 'entity', label: 'Record', width: 1.6 },
      { key: 'entity_id', label: 'Id', width: 1.4, secondary: true },
      { key: 'action', label: 'Action', width: 1.1 },
      { key: 'field', label: 'Field', width: 1, secondary: true },
      { key: 'reason', label: 'Reason given', width: 2.4 },
      { key: 'actor', label: 'By', width: 1.6 },
    ],
    run(ctx) {
      /* The frozen sheet written at submit is excluded: it is one enormous JSON
       * blob per record and it is not a CHANGE anybody made. Everything else is
       * shown, including a create. */
      const w = whereAll([
        { sql: `a.action <> 'snapshot'`, args: [] },
        dateClause(`substr(a.created_at, 1, 10)`, ctx.window),
        ctx.status && ctx.status !== 'all' && ctx.status !== 'active'
          ? { sql: `a.action = ?`, args: [ctx.status] }
          : null,
        textFilter(ctx, ['a.entity_table', 'a.entity_id', 'a.reason', 'a.actor_email', 'a.action']),
      ]);
      const rows = ctx.db.prepare(
        `SELECT a.* FROM fssai_audit_log a ${w.sql}
          ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`,
      ).all(...w.args, lim(ctx) + 1) as any[];
      const truncated = rows.length > lim(ctx);
      const page = truncated ? rows.slice(0, lim(ctx)) : rows;
      const cells = page.map((r) => [
        String(r.created_at || ''),
        String(r.entity_table || ''),
        String(r.entity_id || ''),
        String(r.action || ''),
        String(r.field || ''),
        String(r.reason || ''),
        String(r.actor_name || r.actor_email || ''),
      ]);
      return {
        cells,
        truncated,
        kpis: [
          { label: 'Entries', value: String(page.length) },
          { label: 'Voids', value: String(page.filter((r) => String(r.action) === 'void').length) },
        ],
        note:
          'This trail is append-only: no screen and no route in this module updates or deletes a row in it. ' +
          'The frozen copy of a checklist sheet is left out — it is not a change somebody made.',
      };
    },
  },
];

export function fssaiReport(key: string): FssaiReportDef | null {
  return FSSAI_REPORTS.find((r) => r.key === String(key || '')) || null;
}
