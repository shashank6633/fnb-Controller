/**
 * HRMS — payroll COMPUTE architecture (Phase 4, owner spec §19).
 *
 * SERVER ONLY. Takes an open better-sqlite3 handle as a parameter and is
 * SYNCHRONOUS THROUGHOUT — no awaits, no timers — so every function here is
 * safe to call inside a db.transaction() callback. THE ROUTE OWNS THE
 * TRANSACTION: this module only reads; it never INSERTs/UPDATEs anything.
 * The route takes the returned column-shaped values, INSERTs the
 * hr_payroll_items row, and marks the returned advance installments
 * recovered — all inside ITS transaction.
 *
 * Architecture rules this module enforces (docs/HRMS_DECISIONS.md):
 *  · NO HARDCODED STATUTORY RATES. Every statutory deduction comes from an
 *    hr_statutory_configs row effective in the period; an absent config means
 *    ZERO deduction for that kind, never a built-in fallback rate.
 *  · employee_id is ALWAYS hr_employees.id; reads are LEFT-JOIN tolerant
 *    (a dangling leave_type_id degrades that request to unpaid, traced —
 *    it never throws and never drops the compute).
 *  · Money history is append-only: the salary structure is RESOLVED
 *    (effective-dated), never mutated. hr_advance_installments are consumed
 *    by id by the CALLER, never updated here.
 *  · detail_json is the FULL trace — structure id, config ids, every
 *    intermediate number — frozen into hr_payroll_items so a payslip can be
 *    audited long after configs and structures have moved on.
 *
 * Paid-day rules (each also recorded inside the trace):
 *  · An attendance day counts as paid when its status is NOT one of
 *    ABSENT / NOT_CHECKED_IN / ON_LEAVE. Approved PAID leave is added
 *    from hr_leave_requests PER DATE: a date that already has a paying
 *    attendance row is paid ONCE, as a present day — the leave credit skips
 *    it (unpaid leave stays LOP). HALF_DAY currently counts as a full
 *    paid day (no half-day pay rule exists yet).
 *  · A leave request's recorded days are consumed from from_date forward:
 *    each period credits at most (recorded days − the request's calendar
 *    days before the period), so a cross-month or fractional request can
 *    never pay more total days than were recorded/charged to the balance.
 *  · A MID-MONTH SALARY REVISION is honoured: the month is split into
 *    per-structure segments (each day resolves the structure in effect on
 *    that day) and each segment earns component × (segment paid days /
 *    days-in-month). Every segment is frozen into the trace.
 *
 * Documented v1 limitations (each also recorded inside the trace):
 *  · WEEKLY OFFS ARE NOT MODELLED YET. LOP = days-in-month − paid days, so a
 *    day with no attendance row and no approved paid leave counts toward LOP
 *    — including the weekly off. Until a weekly-off calendar exists, months
 *    must either carry attendance/leave rows for offs or the owner accepts
 *    the proration basis "paid days / calendar days".
 *  · STATUTORY CONFIGS: only state = '' (all-India) rows are selected in v1
 *    — employees carry no state data yet, so state-scoped rates cannot be
 *    resolved and are never applied (a later phase adds employee state).
 *  · Overtime minutes are summed and REPORTED, not paid — no overtime rate
 *    is defined anywhere yet.
 *  · The salary structure's own deductions_json (fixed structural
 *    deductions) is NOT auto-applied — v1 applies statutory + advance
 *    recovery only, per spec. The structure rows are traced so nothing is
 *    silently lost.
 */

import type Database from 'better-sqlite3';
import type { HrPayrollRun } from './hr';

/* ------------------------------------------------------------------ *
 * Result shapes
 * ------------------------------------------------------------------ */

/** One payslip line: {label, amount} — the element shape of earnings_json /
 *  deductions_json in hr_payroll_items. */
export interface PayrollLine {
  label: string;
  amount: number;
}

/** Returned when the employee cannot be computed for the period (no salary
 *  structure in effect, unknown employee, malformed period). The run route
 *  records the skip reason instead of writing a zero payslip. */
export interface PayrollComputeSkip {
  skip: true;
  reason: string;
}

/** A computed payslip, column-shaped for hr_payroll_items: the *_json fields
 *  are ALREADY-SERIALIZED JSON strings ready to bind into the INSERT. */
export interface PayrollComputeItem {
  skip: false;
  /** JSON string: PayrollLine[] (prorated Basic/HRA/allowances). */
  earnings_json: string;
  /** JSON string: PayrollLine[] (statutory + advance recovery; zero lines omitted). */
  deductions_json: string;
  gross: number;
  net: number;
  paid_days: number;
  lop_days: number;
  overtime_minutes: number;
  /** JSON string: the FULL compute trace, frozen (see buildTrace call site). */
  detail_json: string;
  /**
   * The due hr_advance_installments this compute consumed (already inside
   * the deductions). NOT a table column — the route must, in the SAME
   * transaction as its hr_payroll_items INSERT, mark each of these
   * status='recovered', stamp recovered_at + payroll_item_id, and bump the
   * parent hr_advances.recovered_amount. Installments this compute chose to
   * DEFER (they would have pushed net below zero) are not listed here — they
   * stay 'due' and appear in the trace under advance_recovery.deferred.
   */
  advance_installments: Array<{ id: string; advance_id: string; amount: number }>;
}

export type PayrollComputeResult = PayrollComputeSkip | PayrollComputeItem;

/** Options for computePayrollItem. */
export interface ComputePayrollOpts {
  /**
   * RESERVED for a later phase — has NO effect in v1. The compute selects
   * ONLY all-India rows (state = '') from hr_statutory_configs, because
   * employees carry no state data yet: a state-scoped rate cannot be
   * resolved honestly, so it is never applied. When employee state lands,
   * this option scopes matching (rows with state = '' always qualify; rows
   * with a specific state qualify only when it equals this value).
   */
  state?: string;
}

/* ------------------------------------------------------------------ *
 * Period helpers (pure)
 * ------------------------------------------------------------------ */

/** Resolved calendar bounds of a 'YYYY-MM' payroll period. */
export interface PayrollPeriodBounds {
  /** 'YYYY-MM-01'. */
  start: string;
  /** 'YYYY-MM-<last day>'. */
  end: string;
  /** Calendar days in the month (28–31). */
  days: number;
}

/**
 * Parse a 'YYYY-MM' period into its first/last calendar day and day count.
 * Returns null for anything that is not a real month — callers turn that
 * into a skip/400, never a throw.
 */
export function payrollPeriodBounds(period: string): PayrollPeriodBounds | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) return null;
  const [y, m] = period.split('-').map(Number);
  // Date.UTC(year, monthIndex, 0) = day 0 of monthIndex = last day of the
  // previous month; with 1-based m this lands exactly on OUR month's end.
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    start: `${period}-01`,
    end: `${period}-${String(days).padStart(2, '0')}`,
    days,
  };
}

/* ------------------------------------------------------------------ *
 * Small numeric helpers (pure)
 * ------------------------------------------------------------------ */

/** Finite number or 0 — config_json and structure JSON are user-authored. */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Round to 2 decimals (paise). All published amounts are round2'd; the
 *  trace keeps the exact pre-round values. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Safe JSON.parse → object/array or null (never throws). */
function parseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** date + n days as YYYY-MM-DD (UTC arithmetic — inputs are date-only). */
function addDaysIso(date: string, n: number): string {
  return new Date(Date.parse(date) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Inclusive whole-day overlap between [aFrom,aTo] and [bFrom,bTo]
 *  (YYYY-MM-DD strings); 0 when disjoint or malformed. */
function overlapDays(aFrom: string, aTo: string, bFrom: string, bTo: string): number {
  const DAY = 86_400_000;
  const from = Date.parse(aFrom >= bFrom ? aFrom : bFrom);
  const to = Date.parse(aTo <= bTo ? aTo : bTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 0;
  return Math.round((to - from) / DAY) + 1;
}

/* ------------------------------------------------------------------ *
 * Statutory config resolution (generic — the "no hardcoded rates" core)
 * ------------------------------------------------------------------ */

interface StatutoryConfigRow {
  id: string;
  kind: string;
  state: string;
  employee_category: string;
  effective_from: string;
  effective_to: string;
  config_json: string;
  created_at: string;
}

/**
 * Pick the single best config row per kind for this employee + period.
 * Candidates were already filtered to "effective in the period, active".
 * Ranking (most specific wins, then latest): category match > category '',
 * state match > state '' (rows with a non-matching category or state were
 * excluded before ranking), then effective_from DESC, created_at DESC.
 */
function resolveStatutoryConfigs(
  candidates: StatutoryConfigRow[],
  employeeCategory: string,
  state: string,
): Map<string, StatutoryConfigRow> {
  const byKind = new Map<string, StatutoryConfigRow[]>();
  for (const row of candidates) {
    if (row.employee_category !== '' && row.employee_category !== employeeCategory) continue;
    if (row.state !== '' && row.state !== state) continue;
    const list = byKind.get(row.kind) ?? [];
    list.push(row);
    byKind.set(row.kind, list);
  }
  const resolved = new Map<string, StatutoryConfigRow>();
  for (const [kind, list] of byKind) {
    list.sort((a, b) => {
      const catA = a.employee_category === '' ? 0 : 1;
      const catB = b.employee_category === '' ? 0 : 1;
      if (catA !== catB) return catB - catA;
      const stA = a.state === '' ? 0 : 1;
      const stB = b.state === '' ? 0 : 1;
      if (stA !== stB) return stB - stA;
      if (a.effective_from !== b.effective_from) {
        return a.effective_from < b.effective_from ? 1 : -1;
      }
      return a.created_at < b.created_at ? 1 : -1;
    });
    resolved.set(kind, list[0]);
  }
  return resolved;
}

/* ------------------------------------------------------------------ *
 * computePayrollItem
 * ------------------------------------------------------------------ */

/**
 * Compute one employee's payslip numbers for a 'YYYY-MM' period.
 *
 * READ-ONLY and synchronous — call it inside the run route's
 * db.transaction() alongside the INSERT that freezes its output. Returns
 * either {skip:true, reason} (no salary structure in effect / unknown
 * employee / malformed period) or the column-shaped PayrollComputeItem.
 *
 * The pipeline, in order (every step lands in detail_json):
 *  1. Resolve ALL salary structures overlapping the period (effective_from
 *     ≤ period end, effective_to '' or ≥ period start). None → skip. Each
 *     day of the month resolves the structure in effect ON THAT DAY (latest
 *     effective_from ≤ day, then latest created_at); consecutive days with
 *     the same structure form a segment, so a mid-month revision splits the
 *     month instead of paying the new structure for the whole month.
 *  2. Paid days PER DATE: a date is paid when it has a paying attendance
 *     row (status ∉ ABSENT/NOT_CHECKED_IN/ON_LEAVE), else by approved PAID
 *     leave credit. Leave credit skips dates already paid by attendance
 *     (double-pay guard) and consumes the request's recorded days from
 *     from_date forward, so a cross-month/fractional request never credits
 *     more than it recorded. Capped at days-in-month; LOP = days-in-month −
 *     paid days (weekly offs are NOT modelled yet — see the file header).
 *  3. Earnings = Σ over segments of structure components (Basic, HRA,
 *     allowances) × (segment paid days / days-in-month); gross = their sum.
 *  4. Statutory deductions GENERICALLY from hr_statutory_configs
 *     (pf {percent_of_basic, wage_cap} · esi {percent_of_gross, gross_cap}
 *     · professional_tax {slabs:[{upto, amount}]}); absent config = 0.
 *     v1 selects ONLY state = '' (all-India) rows — employees carry no
 *     state data, so state-scoped rates are never applied (later phase).
 *  5. Advance recovery consumes this period's due hr_advance_installments
 *     of DISBURSED advances only (recovery presupposes the money was paid
 *     out), greedily, never below net 0 — deferred ones stay due.
 */
export function computePayrollItem(
  db: Database.Database,
  employee_id: string,
  period: string,
  opts?: ComputePayrollOpts,
): PayrollComputeResult {
  const bounds = payrollPeriodBounds(period);
  if (!bounds) return { skip: true, reason: 'Invalid payroll period (expected YYYY-MM)' };

  const employee = db
    .prepare(
      `SELECT id, employee_code, full_name, employee_category, status
       FROM hr_employees WHERE id = ?`,
    )
    .get(employee_id) as
    | { id: string; employee_code: string; full_name: string; employee_category: string; status: string }
    | undefined;
  if (!employee) return { skip: true, reason: 'Employee not found' };

  /* 1 ── ALL salary structures overlapping the period (append-only history:
   *      resolved by date, never mutated). Each calendar day is paid from
   *      the structure in effect ON THAT DAY, so a mid-month revision splits
   *      the month into segments instead of paying one structure throughout. */
  const structureRows = db
    .prepare(
      `SELECT id, employee_id, effective_from, effective_to, basic, hra,
              allowances_json, gross, deductions_json, net, created_at
       FROM hr_salary_structures
       WHERE employee_id = ?
         AND effective_from <= ?
         AND (effective_to = '' OR effective_to >= ?)
       ORDER BY effective_from ASC, created_at ASC`,
    )
    .all(employee_id, bounds.end, bounds.start) as Array<{
    id: string;
    employee_id: string;
    effective_from: string;
    effective_to: string;
    basic: number;
    hra: number;
    allowances_json: string;
    gross: number;
    deductions_json: string;
    net: number;
    created_at: string;
  }>;
  if (structureRows.length === 0) {
    return { skip: true, reason: `No salary structure in effect for ${period}` };
  }

  const parsedStructures = structureRows.map((row) => {
    const basic = num(row.basic);
    const hra = num(row.hra);
    const allowancesRaw = parseJson(row.allowances_json);
    const allowances: PayrollLine[] = Array.isArray(allowancesRaw)
      ? allowancesRaw.map((a: unknown) => {
          const rec = (a ?? {}) as Record<string, unknown>;
          return { label: String(rec.label ?? '').trim() || 'Allowance', amount: num(rec.amount) };
        })
      : [];
    return {
      row,
      basic,
      hra,
      allowances,
      monthlyGross: round2(basic + hra + allowances.reduce((s, a) => s + a.amount, 0)),
    };
  });
  type ParsedStructure = (typeof parsedStructures)[number];

  // The structure in effect on one date: rows are sorted effective_from ASC,
  // created_at ASC, so the LAST match is the latest effective_from (ties →
  // latest created_at) — the same resolution rule as before, applied per day.
  const structureForDate = (date: string): ParsedStructure | null => {
    let hit: ParsedStructure | null = null;
    for (const ps of parsedStructures) {
      if (ps.row.effective_from <= date && (ps.row.effective_to === '' || ps.row.effective_to >= date)) {
        hit = ps;
      }
    }
    return hit;
  };

  // Consecutive days with the same structure collapse into one segment.
  // Days no structure covers (e.g. before the first effective_from) form a
  // null segment that earns nothing — traced, never guessed at.
  const segments: Array<{ from: string; to: string; days: number; structure: ParsedStructure | null }> = [];
  for (let i = 0; i < bounds.days; i++) {
    const date = addDaysIso(bounds.start, i);
    const ps = structureForDate(date);
    const last = segments[segments.length - 1];
    if (last && (last.structure?.row.id ?? null) === (ps?.row.id ?? null)) {
      last.to = date;
      last.days += 1;
    } else {
      segments.push({ from: date, to: date, days: 1, structure: ps });
    }
  }

  // ESI eligibility judges the FULL monthly gross; with a mid-month revision
  // the structure in effect at period END is the going rate — traced below.
  const latestStructure =
    [...segments].reverse().find((s) => s.structure)?.structure ??
    parsedStructures[parsedStructures.length - 1];
  const monthlyGross = latestStructure.monthlyGross;

  /* 2 ── paid days, PER DATE. Attendance count excludes ON_LEAVE on purpose:
   *      approved PAID leave is added below from hr_leave_requests, so
   *      counting the ON_LEAVE summary row too would double-pay the day —
   *      and UNPAID leave must stay LOP. The paying DATES are kept so the
   *      leave credit below can skip days already paid by attendance. */
  const attRows = db
    .prepare(
      `SELECT date, status
       FROM hr_attendance
       WHERE employee_id = ? AND date >= ? AND date <= ?`,
    )
    .all(employee_id, bounds.start, bounds.end) as Array<{ date: string; status: string }>;
  const UNPAID_ATTENDANCE_STATUSES = new Set(['ABSENT', 'NOT_CHECKED_IN', 'ON_LEAVE']);
  const statusCounts = new Map<string, number>();
  const presentDates = new Set<string>();
  for (const r of attRows) {
    statusCounts.set(r.status, (statusCounts.get(r.status) ?? 0) + 1);
    if (!UNPAID_ATTENDANCE_STATUSES.has(r.status)) presentDates.add(r.date);
  }
  const attStatuses = [...statusCounts.entries()]
    .map(([status, n]) => ({ status, n }))
    .sort((a, b) => (a.status < b.status ? -1 : a.status > b.status ? 1 : 0));
  const presentDays = presentDates.size;

  const otRow = db
    .prepare(
      `SELECT COALESCE(SUM(overtime_minutes), 0) AS ot
       FROM hr_attendance
       WHERE employee_id = ? AND date >= ? AND date <= ?`,
    )
    .get(employee_id, bounds.start, bounds.end) as { ot: number };
  const overtime_minutes = Math.max(0, Math.round(num(otRow?.ot)));

  // Approved leave overlapping the period. LEFT JOIN: a dangling
  // leave_type_id gives is_paid NULL → treated UNPAID and traced, the
  // request is never dropped from the trace and never throws.
  const leaveRows = db
    .prepare(
      `SELECT lr.id, lr.leave_type_id, lr.from_date, lr.to_date, lr.days,
              lt.is_paid, lt.name AS leave_type_name
       FROM hr_leave_requests lr
       LEFT JOIN hr_leave_types lt ON lt.id = lr.leave_type_id
       WHERE lr.employee_id = ? AND lr.status = 'approved'
         AND lr.from_date <= ? AND lr.to_date >= ?
       ORDER BY lr.from_date, lr.id`,
    )
    .all(employee_id, bounds.end, bounds.start) as Array<{
    id: string;
    leave_type_id: string;
    from_date: string;
    to_date: string;
    days: number;
    is_paid: number | null;
    leave_type_name: string | null;
  }>;

  let paidLeaveDays = 0;
  // Per-date paid-leave credit (0..1 per calendar day). The map caps a day
  // at 1 so two overlapping approved requests can never credit it twice.
  const leaveCredit = new Map<string, number>();
  const leaveTrace = leaveRows.map((lr) => {
    const overlap = overlapDays(lr.from_date, lr.to_date, bounds.start, bounds.end);
    const paid = lr.is_paid === 1;
    // Cross-month/fractional allocation rule: the request's recorded days
    // (can be fractional, 0.5 steps) are consumed from from_date forward.
    // days_before_period = the request's calendar days BEFORE this period,
    // so this period may credit at most (recorded − days_before_period) —
    // a 3-day request spanning two months can never pay more than 3 in
    // total, and a half-day stays 0.5.
    const recordedDays = num(lr.days);
    const daysBefore =
      lr.from_date < bounds.start
        ? overlapDays(lr.from_date, lr.to_date, lr.from_date, addDaysIso(bounds.start, -1))
        : 0;
    let remaining = paid ? Math.max(0, round2(recordedDays - daysBefore)) : 0;
    const remainingAtStart = remaining;
    // Double-pay guard: a date with a PAYING attendance row inside the leave
    // span is already paid as a present day — the leave credit skips it.
    let presentInOverlap = 0;
    let counted = 0;
    if (overlap > 0) {
      const overlapFrom = lr.from_date >= bounds.start ? lr.from_date : bounds.start;
      for (let i = 0; i < overlap; i++) {
        const date = addDaysIso(overlapFrom, i);
        if (presentDates.has(date)) {
          presentInOverlap += 1;
          continue;
        }
        if (remaining <= 0) continue;
        const already = leaveCredit.get(date) ?? 0;
        const room = round2(1 - already);
        if (room <= 0) continue;
        const credit = round2(Math.min(1, remaining, room));
        if (credit <= 0) continue;
        leaveCredit.set(date, round2(already + credit));
        remaining = round2(remaining - credit);
        counted = round2(counted + credit);
      }
    }
    if (paid) paidLeaveDays = round2(paidLeaveDays + counted);
    return {
      leave_request_id: lr.id,
      leave_type_id: lr.leave_type_id,
      leave_type_name: lr.leave_type_name ?? '(missing leave type)',
      is_paid: paid,
      from_date: lr.from_date,
      to_date: lr.to_date,
      recorded_days: recordedDays,
      overlap_days_in_period: overlap,
      present_days_in_overlap: presentInOverlap,
      days_before_period: daysBefore,
      remaining_days_for_period: remainingAtStart,
      paid_days_counted: counted,
    };
  });
  paidLeaveDays = round2(paidLeaveDays);

  const paidDaysUncapped = round2(presentDays + paidLeaveDays);
  const paid_days = Math.min(paidDaysUncapped, bounds.days);
  const lop_days = round2(bounds.days - paid_days);

  /* 3 ── prorate earnings PER SEGMENT: each segment earns its structure's
   *      components × (segment paid days / days-in-month). A single
   *      structure covering the whole month reduces to the old
   *      paid/(days-in-month) factor exactly. */
  const paidValueOn = (date: string): number =>
    presentDates.has(date) ? 1 : (leaveCredit.get(date) ?? 0);

  let earnedBasicExact = 0;
  let earnedHraExact = 0;
  const allowanceExact = new Map<string, number>(); // label → exact sum (first-seen order)
  const segmentTrace: Array<Record<string, unknown>> = [];
  for (const seg of segments) {
    let segPaid = 0;
    for (let i = 0; i < seg.days; i++) segPaid += paidValueOn(addDaysIso(seg.from, i));
    segPaid = round2(segPaid);
    const segFactor = segPaid / bounds.days;
    if (seg.structure) {
      earnedBasicExact += seg.structure.basic * segFactor;
      earnedHraExact += seg.structure.hra * segFactor;
      for (const a of seg.structure.allowances) {
        allowanceExact.set(a.label, (allowanceExact.get(a.label) ?? 0) + a.amount * segFactor);
      }
    }
    segmentTrace.push({
      from: seg.from,
      to: seg.to,
      calendar_days: seg.days,
      paid_days: segPaid,
      factor: segFactor,
      structure_id: seg.structure?.row.id ?? null,
      structure_effective_from: seg.structure?.row.effective_from ?? null,
      structure_monthly_gross: seg.structure?.monthlyGross ?? null,
      ...(seg.structure
        ? {}
        : { note: 'No salary structure in effect on these days — they earn nothing.' }),
    });
  }
  const earnings: PayrollLine[] = [
    { label: 'Basic', amount: round2(earnedBasicExact) },
    { label: 'HRA', amount: round2(earnedHraExact) },
    ...[...allowanceExact.entries()].map(([label, exact]) => ({ label, amount: round2(exact) })),
  ];
  const earnedBasic = earnings[0].amount;
  const gross = round2(earnings.reduce((s, e) => s + e.amount, 0));

  /* 4 ── statutory deductions, GENERICALLY from config rows. No config for a
   *      kind = zero deduction for that kind, never a built-in rate.
   *      v1 selects ONLY state = '' (all-India) rows: employees carry no
   *      state data yet, so a state-scoped rate cannot be resolved honestly
   *      and is never applied (opts.state is reserved for that later phase). */
  const stateScope = String(opts?.state ?? '').trim();
  const candidates = db
    .prepare(
      `SELECT id, kind, state, employee_category, effective_from, effective_to,
              config_json, created_at
       FROM hr_statutory_configs
       WHERE is_active = 1
         AND state = ''
         AND effective_from <= ?
         AND (effective_to = '' OR effective_to >= ?)`,
    )
    .all(bounds.end, bounds.start) as StatutoryConfigRow[];
  const configs = resolveStatutoryConfigs(candidates, employee.employee_category, stateScope);

  const deductions: PayrollLine[] = [];
  const statutoryTrace: Array<Record<string, unknown>> = [];

  const pushDeduction = (label: string, amount: number) => {
    if (amount > 0) deductions.push({ label, amount });
  };

  if (gross <= 0) {
    statutoryTrace.push({
      note: 'Earned gross is 0 — statutory deductions skipped entirely for this period.',
    });
  } else {
    // PF — {percent_of_basic, wage_cap}. Base = EARNED (prorated) basic,
    // capped at wage_cap when the config sets one (>0).
    const pf = configs.get('pf');
    const pfCfg = pf ? (parseJson(pf.config_json) as Record<string, unknown> | null) : null;
    if (pf && pfCfg) {
      const pct = num(pfCfg.percent_of_basic);
      const cap = num(pfCfg.wage_cap);
      const base = cap > 0 ? Math.min(earnedBasic, cap) : earnedBasic;
      const exact = (base * pct) / 100;
      const amount = round2(exact);
      pushDeduction('PF', amount);
      statutoryTrace.push({
        kind: 'pf', config_id: pf.id, percent_of_basic: pct, wage_cap: cap,
        earned_basic: earnedBasic, base_after_cap: base, exact, amount,
      });
    } else {
      statutoryTrace.push({
        kind: 'pf',
        config_id: pf?.id ?? null,
        amount: 0,
        note: pf ? 'Config row found but config_json is not valid JSON — treated as absent.'
                 : 'No effective config — zero deduction (never a built-in rate).',
      });
    }

    // ESI — {percent_of_gross, gross_cap}. gross_cap is an ELIGIBILITY
    // ceiling judged on the structure's FULL monthly gross (an LOP-shortened
    // month must not pull a high earner into coverage); the percent applies
    // to the EARNED gross.
    const esi = configs.get('esi');
    const esiCfg = esi ? (parseJson(esi.config_json) as Record<string, unknown> | null) : null;
    if (esi && esiCfg) {
      const pct = num(esiCfg.percent_of_gross);
      const cap = num(esiCfg.gross_cap);
      const eligible = !(cap > 0 && monthlyGross > cap);
      const exact = eligible ? (gross * pct) / 100 : 0;
      const amount = round2(exact);
      pushDeduction('ESI', amount);
      statutoryTrace.push({
        kind: 'esi', config_id: esi.id, percent_of_gross: pct, gross_cap: cap,
        monthly_gross: monthlyGross, earned_gross: gross, eligible, exact, amount,
      });
    } else {
      statutoryTrace.push({
        kind: 'esi',
        config_id: esi?.id ?? null,
        amount: 0,
        note: esi ? 'Config row found but config_json is not valid JSON — treated as absent.'
                  : 'No effective config — zero deduction (never a built-in rate).',
      });
    }

    // Professional tax — {slabs: [{upto, amount}]}. Flat slab amount (NOT
    // prorated — PT is a per-month levy) against the EARNED gross. upto <= 0
    // means "no upper bound"; slabs are matched in ascending order.
    const pt = configs.get('professional_tax');
    const ptCfg = pt ? (parseJson(pt.config_json) as Record<string, unknown> | null) : null;
    const slabsRaw = ptCfg && Array.isArray(ptCfg.slabs) ? (ptCfg.slabs as unknown[]) : null;
    if (pt && slabsRaw) {
      const slabs = slabsRaw
        .map((s: unknown) => {
          const rec = (s ?? {}) as Record<string, unknown>;
          return { upto: num(rec.upto), amount: num(rec.amount) };
        })
        .sort((a, b) => {
          const ua = a.upto <= 0 ? Number.POSITIVE_INFINITY : a.upto;
          const ub = b.upto <= 0 ? Number.POSITIVE_INFINITY : b.upto;
          return ua - ub;
        });
      const hit = slabs.find((s) => gross <= (s.upto <= 0 ? Number.POSITIVE_INFINITY : s.upto));
      const amount = round2(hit ? hit.amount : 0);
      pushDeduction('Professional Tax', amount);
      statutoryTrace.push({
        kind: 'professional_tax', config_id: pt.id, slabs, earned_gross: gross,
        matched_slab: hit ?? null, amount,
        ...(hit ? {} : { note: 'Earned gross exceeds every bounded slab and no unbounded slab exists — 0.' }),
      });
    } else {
      statutoryTrace.push({
        kind: 'professional_tax',
        config_id: pt?.id ?? null,
        amount: 0,
        note: pt ? 'Config row found but config_json has no valid slabs array — treated as absent.'
                 : 'No effective config — zero deduction (never a built-in rate).',
      });
    }

    // Any OTHER effective kinds (tds/bonus/gratuity/min_wage/...) have no
    // generic monthly-deduction shape yet — recorded, never guessed at.
    for (const [kind, row] of configs) {
      if (kind === 'pf' || kind === 'esi' || kind === 'professional_tax') continue;
      statutoryTrace.push({
        kind, config_id: row.id, amount: 0,
        note: 'Kind has no generic monthly-deduction rule in v1 — recorded only, not applied.',
      });
    }
  }

  /* 5 ── advance recovery: this period's due installments, applied greedily
   *      in order without pushing net below zero. Whole installments only —
   *      one that does not fit stays 'due' (deferred, traced) because a
   *      partial recovery would corrupt the append-only installment ledger.
   *      ONLY status='disbursed' advances are recovered — recovery
   *      presupposes the employee actually received the money; an approved
   *      but undisbursed advance's installments stay due, untouched. */
  const dueInstallments = db
    .prepare(
      `SELECT ai.id, ai.advance_id, ai.amount
       FROM hr_advance_installments ai
       JOIN hr_advances a ON a.id = ai.advance_id
       WHERE a.employee_id = ? AND ai.period = ? AND ai.status = 'due'
         AND a.status = 'disbursed'
       ORDER BY ai.id`,
    )
    .all(employee_id, period) as Array<{ id: string; advance_id: string; amount: number }>;

  const statutoryTotal = round2(deductions.reduce((s, d) => s + d.amount, 0));
  let recoveryRoom = round2(Math.max(0, gross - statutoryTotal));
  const appliedInstallments: Array<{ id: string; advance_id: string; amount: number }> = [];
  const deferredInstallments: Array<{ id: string; advance_id: string; amount: number; reason: string }> = [];
  for (const inst of dueInstallments) {
    const amount = round2(num(inst.amount));
    if (amount <= 0) {
      deferredInstallments.push({ ...inst, amount, reason: 'Non-positive installment amount' });
      continue;
    }
    if (amount <= recoveryRoom) {
      appliedInstallments.push({ id: inst.id, advance_id: inst.advance_id, amount });
      recoveryRoom = round2(recoveryRoom - amount);
    } else {
      deferredInstallments.push({
        ...inst, amount, reason: 'Would push net below zero — left due for a later period',
      });
    }
  }
  const advanceRecoveryTotal = round2(appliedInstallments.reduce((s, i) => s + i.amount, 0));
  if (advanceRecoveryTotal > 0) {
    deductions.push({ label: 'Advance Recovery', amount: advanceRecoveryTotal });
  }

  const totalDeductions = round2(deductions.reduce((s, d) => s + d.amount, 0));
  const net = round2(gross - totalDeductions);

  /* ── the frozen trace: every id and intermediate number of the compute. */
  const detail = {
    version: 1,
    period,
    period_start: bounds.start,
    period_end: bounds.end,
    days_in_month: bounds.days,
    employee: {
      id: employee.id,
      employee_code: employee.employee_code,
      employee_category: employee.employee_category,
      status: employee.status,
    },
    structures: {
      resolved: parsedStructures.map((ps) => ({
        id: ps.row.id,
        effective_from: ps.row.effective_from,
        effective_to: ps.row.effective_to,
        basic: ps.basic,
        hra: ps.hra,
        allowances: ps.allowances,
        monthly_gross_computed: ps.monthlyGross,
        stored_gross: num(ps.row.gross),
        stored_deductions_json: ps.row.deductions_json,
      })),
      monthly_gross_basis_structure_id: latestStructure.row.id,
      note:
        'Every structure overlapping the period; each day is paid from the structure in ' +
        'effect on that day (see proration.segments — a mid-month revision splits the month). ' +
        'ESI eligibility judges the monthly gross of the structure in effect at period end. ' +
        'Structure-level deductions_json is informational in v1 — NOT auto-applied.',
    },
    attendance: {
      status_counts: attStatuses,
      unpaid_statuses: [...UNPAID_ATTENDANCE_STATUSES],
      present_days: presentDays,
      overtime_minutes,
      note:
        'ON_LEAVE excluded here because approved PAID leave is added from ' +
        'hr_leave_requests below (double-count guard); HALF_DAY counts as a full day in v1.',
    },
    leave: {
      requests: leaveTrace,
      paid_leave_days: paidLeaveDays,
      note:
        'Per-date credit: a date with a paying attendance row is paid ONCE as a present day ' +
        '(the leave credit skips it); a request consumes its recorded days from from_date ' +
        'forward, so each period credits at most (recorded days − calendar days before the ' +
        'period); overlapping requests cannot credit the same day twice.',
    },
    paid_days_calc: {
      present_days: presentDays,
      paid_leave_days: paidLeaveDays,
      uncapped: paidDaysUncapped,
      capped_at_days_in_month: paidDaysUncapped > bounds.days,
      paid_days,
      lop_days,
      note:
        'Weekly offs are NOT modelled yet — every day of the month without an ' +
        'attendance row or approved paid leave counts toward LOP.',
    },
    proration: {
      basis: 'per-segment: component × (segment paid days / days in month)',
      days_in_month: bounds.days,
      segments: segmentTrace,
      earnings,
    },
    statutory: {
      state_scope:
        (stateScope || '(none)') +
        ' — v1 selects only all-India (state = \'\') config rows; employees carry no state data, so state-scoped rates need employee state data, a later phase.',
      configs_considered: candidates.map((c) => ({
        id: c.id, kind: c.kind, state: c.state, employee_category: c.employee_category,
        effective_from: c.effective_from, effective_to: c.effective_to,
      })),
      applied: statutoryTrace,
      total: statutoryTotal,
    },
    advance_recovery: {
      due: dueInstallments.map((i) => ({ ...i, amount: round2(num(i.amount)) })),
      applied: appliedInstallments,
      deferred: deferredInstallments,
      total_applied: advanceRecoveryTotal,
      note: "Only installments of status='disbursed' advances are recovered — an approved but undisbursed advance is never deducted.",
    },
    overtime: {
      minutes: overtime_minutes,
      note: 'Reported only — no overtime pay rate is defined in v1.',
    },
    totals: { gross, total_deductions: totalDeductions, net },
  };

  return {
    skip: false,
    earnings_json: JSON.stringify(earnings),
    deductions_json: JSON.stringify(deductions),
    gross,
    net,
    paid_days,
    lop_days,
    overtime_minutes,
    detail_json: JSON.stringify(detail),
    advance_installments: appliedInstallments,
  };
}

/* ------------------------------------------------------------------ *
 * finalizeRunGuard
 * ------------------------------------------------------------------ */

/**
 * Preconditions for finalizing a payroll run. Returns a human-readable error
 * string (the route sends it as its 4xx message) or null when the run may be
 * finalized. Read-only and synchronous — safe inside the route's
 * db.transaction() so the check and the status flip are atomic. A finalized
 * run is IMMUTABLE (schema contract) — this guard is what enforces the
 * "only once" edge of that rule.
 */
export function finalizeRunGuard(
  db: Database.Database,
  run: Pick<HrPayrollRun, 'id' | 'status'> | null | undefined,
): string | null {
  if (!run || !run.id) return 'Payroll run not found';
  if (run.status === 'finalized') return 'This payroll run is already finalized';
  if (run.status !== 'draft') return 'Only a draft payroll run can be finalized';
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM hr_payroll_items WHERE run_id = ?')
    .get(run.id) as { n: number };
  if (!row || row.n === 0) {
    return 'This payroll run has no computed items yet — compute the period before finalizing';
  }
  return null;
}
