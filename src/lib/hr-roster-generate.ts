import type Database from 'better-sqlite3';
import { generateId, logAuditEvent } from './db';
import {
  EXITED_STATUSES,
  getHrDayCutoff,
  getHrRosterOffsWeekdays,
  getHrRosterRotateShifts,
  getHrWeeklyOffPolicy,
  type HrWeeklyOffPolicy,
} from './hr-attendance';

/**
 * Weekly roster GENERATOR — HRMS roster phase, Stage 2.
 *
 * Two exports and a hard line between them:
 *   generateRosterPlan(db, input)  PURE. Reads, decides, explains. WRITES NOTHING.
 *   commitRosterPlan(db, plan, …)  Writes the plan's SHIFT rows in ONE transaction.
 *
 * ── THE OWNER'S FOUR RULES (confirmed verbatim, and what each one costs here) ──
 *  1. Weekly offs land Mon-Thu ONLY — "it is a Pub, weekend is more busy".
 *     Measured in his own Captains grid: Mon 5, Tue 7, Wed 4, Thu 4, Fri/Sat/Sun
 *     ZERO. Enforced by only ever considering dates whose weekday is in
 *     hr_roster_offs_weekdays (default Mon-Thu), which the setting getter can
 *     never return empty — an empty allow-list read as "any day" is precisely how
 *     a Saturday off would appear.
 *  2. Shift rotation is a SETTING (hr_roster_rotate_shifts). ON = rotate people
 *     between shift roles week over week (his usual). OFF = keep each person on
 *     their usual role and move ONLY the off day. Both paths are live below.
 *  3. Coverage is a SETTING expressed as MINIMUM PRESENT per group per day —
 *     never a max-offs cap. Nothing here stores or derives a max-offs number:
 *     offs are placed as "the most offs that still leave min_present present".
 *  4. One weekly off each; approved leave blanks the whole row and overrides
 *     everything. Leave is checked first and is never rostered over, and it is
 *     NOT the weekly off (a person on leave all week simply has no off to place).
 *
 * ── OFFS ARE NOT PERSISTED (owner decision, "go with 3") ──────────────────────
 * The plan carries offs so the grid and the printout can render them; commit
 * writes only SHIFT rows into hr_rosters. Two measured reasons, both still true:
 *   1. hr_rosters cannot express an off — shift_id is NOT NULL and there is no
 *      off concept in its column vocabulary.
 *   2. An off stored as a roster row becomes a FALSE ABSENT.
 *      src/lib/reports/hr-attendance-register.ts counts a roster row with no
 *      matching attendance row as absent and does NOT join hr_shifts, so it
 *      cannot tell a rostered shift from a rostered rest day. That file is
 *      deliberately untouched.
 * Under the OPTIONAL hr_weekly_off_policy='paid' an off is recorded as an
 * hr_attendance row with status WEEKLY_OFF — the attendance register, not the
 * roster, and a status payroll already pays (it is absent from hr-payroll.ts's
 * UNPAID_ATTENDANCE_STATUSES, so no payroll arithmetic moves).
 *
 * ── NO DEPARTMENT OR DESIGNATION NAME IS HARDCODED ────────────────────────────
 * departments / hr_designations are the owner's masters, read at runtime and
 * never created. The stale local database still carries a legacy "Akan Service"
 * department that production does NOT have (production: 15 departments, none
 * containing "Service"), so a generator keyed on a NAME would configure a venue
 * that does not exist. Groups are DESIGNATIONS inside one department, whatever
 * they are called.
 *
 * ── IT REFUSES RATHER THAN GUESSES ────────────────────────────────────────────
 * Production measured 2026-10-06: 129 employees on rolls, 128 with no
 * department, 129 with no sub-department, ZERO hr_shifts, ZERO hr_rosters rows
 * ever. The usual case is therefore "nothing to work with", so every missing
 * input is a NAMED refusal and `ok` goes false. A plan is never blank-and-silent:
 * when refusals exist the rows and the write lists are emptied on purpose, so no
 * caller can mistake a half-configured week for a roster.
 *
 * ── DETERMINISM ───────────────────────────────────────────────────────────────
 * Same inputs, same plan — byte for byte. Every tie-break is seeded from stable
 * data (employee_code, then id). No Math.random, no Date.now, no reliance on row
 * order: every query that feeds a decision carries its own ORDER BY.
 */

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

/** 0=Sun .. 6=Sat — JS getDay / SQLite %w, the order hr_roster_* weekday uses. */
const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * hr_rosters.source value for a row this generator wrote.
 *
 * WHY A MARKER EXISTS AT ALL: a manual edit is the manager's and WINS. Without
 * provenance a re-run cannot tell its own last output from a hand edit, and
 * "regenerate" would quietly overwrite the fix someone made at 7pm. Rows with
 * any other source — including '' on every row written before this column
 * existed — are treated as MANUAL, i.e. protected. Unknown provenance fails
 * towards "leave it alone".
 */
export const ROSTER_SOURCE_GENERATED = 'generated';

/** Scope label for a coverage row that names no designation. */
const WHOLE_DEPARTMENT = 'Whole department';

/** A shift role must resolve per weekday; this is the cap on how many missing
 *  (role, weekday) pairs we name before saying "and N more" — a brand-new venue
 *  would otherwise return a wall of text. */
const MAX_NAMED = 12;

/* ------------------------------------------------------------------ *
 * Public shapes
 * ------------------------------------------------------------------ */

export type RosterRowKind = 'shift' | 'off' | 'leave';

/** One cell of the week grid: one employee on one date. */
export interface RosterPlanRow {
  employee_id: string;
  employee_code: string;
  employee_name: string;
  designation_id: string;
  designation_name: string;
  /** YYYY-MM-DD (IST business date). */
  date: string;
  /** 0=Sun .. 6=Sat. */
  weekday: number;
  kind: RosterRowKind;
  /** The owner's own shift vocabulary (MS / M 2 C / MOR BREAK / SECOND /
   *  NIGHT); '' on an off or leave row. */
  shift_role: string;
  /** hr_shifts.id; '' on an off or leave row. */
  shift_id: string;
  shift_name: string;
  /** Short human WHY, so the UI can answer "why is X off on Tuesday?". */
  reason: string;
}

/** One designation inside the department — a coverage GROUP. */
export interface RosterPlanGroup {
  designation_id: string;
  designation_name: string;
  employee_count: number;
  /** shift_role → how many of this group carry it this week. */
  role_counts: Record<string, number>;
  /** date → how many of this group are off that day. */
  offs_by_date: Record<string, number>;
}

/** One coverage floor measured against the plan, for one date. */
export interface RosterCoverageLine {
  date: string;
  weekday: number;
  /** hr_designations.id, '' = the whole department. */
  designation_id: string;
  /** Designation name, or 'Whole department'. */
  group: string;
  /** '' = the day TOTAL across every shift. */
  shift_role: string;
  min_present: number;
  planned_present: number;
  /** max(0, min_present - planned_present). > 0 is a breach. */
  shortfall: number;
  off_count: number;
  leave_count: number;
}

/** A coverage floor the plan could not keep. Named group, named date, named
 *  shortfall — never a silent under-staff. */
export interface RosterBreach {
  date: string;
  weekday: number;
  designation_id: string;
  group: string;
  shift_role: string;
  min_present: number;
  planned_present: number;
  shortfall: number;
  message: string;
}

/** A missing INPUT. Refusals make `ok` false and empty the plan's rows. */
export interface RosterRefusal {
  code: string;
  message: string;
  /** The concrete missing thing, so a UI can deep-link the fix. */
  detail?: Record<string, string | number>;
}

/** Exactly what commit upserts into hr_rosters. */
export interface RosterShiftWrite {
  employee_id: string;
  date: string;
  shift_id: string;
  note: string;
}

/** An off day — rendered always, recorded as WEEKLY_OFF attendance only under
 *  hr_weekly_off_policy='paid'. Never a hr_rosters row. */
export interface RosterOffWrite {
  employee_id: string;
  date: string;
}

export interface RosterPlanInput {
  /** departments.id. Read from the master; never a name, never a default. */
  department_id: string;
  /** YYYY-MM-DD, day 1 of the 7-day grid (the caller supplies the Monday). */
  week_start: string;
  /** What-if override for hr_roster_rotate_shifts (preview only). */
  rotate_shifts?: boolean;
  /** What-if override for hr_roster_offs_weekdays (preview only). Empty or all
   *  invalid falls back to the saved setting — never to "any day". */
  offs_weekdays?: number[];
}

export interface RosterPlan {
  /** false ⇒ refusals present, rows/writes deliberately empty, nothing to commit. */
  ok: boolean;
  department_id: string;
  department_name: string;
  week_start: string;
  week_end: string;
  /** The 7 dates, week_start first. */
  dates: string[];
  /** Effective settings this plan was built with (after any what-if override). */
  rotate_shifts: boolean;
  offs_weekdays: number[];
  weekly_off_policy: HrWeeklyOffPolicy;
  /** Previous week read for rotation (week_start - 7 .. week_start - 1). */
  previous_week_start: string;
  groups: RosterPlanGroup[];
  rows: RosterPlanRow[];
  coverage: RosterCoverageLine[];
  breaches: RosterBreach[];
  refusals: RosterRefusal[];
  /** Honest degradations that are not refusals (stale config, no history, …). */
  warnings: string[];
  shift_writes: RosterShiftWrite[];
  off_writes: RosterOffWrite[];
}

export interface RosterCommitResult {
  ok: boolean;
  error?: string;
  shift_rows_written: number;
  /** Generator rows removed because that day is now an off or a leave day. */
  stale_rows_removed: number;
  /** Days left exactly as they were because a human owns them. */
  kept_manual: Array<{ employee_id: string; date: string }>;
  weekly_off_rows_written: number;
  /** An off day that already had attendance — a real punch is never overwritten. */
  weekly_off_rows_skipped: Array<{ employee_id: string; date: string; existing_status: string }>;
}

/* ------------------------------------------------------------------ *
 * Date + hash helpers (pure string/UTC arithmetic — no TZ drift)
 * ------------------------------------------------------------------ */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** date + n days in YYYY-MM-DD space. */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0=Sun .. 6=Sat for a YYYY-MM-DD date. Parsed as UTC midnight so the weekday
 *  is a property of the DATE STRING and not of the server's timezone. */
function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** 'HH:MM' → minutes past midnight, null for garbage. Same rule as
 *  hr-attendance.ts's own private parser (kept local — that one is not exported,
 *  and a second copy is cheaper than widening that module's surface). */
function hhmmToMinutes(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * FNV-1a 32-bit over a stable string.
 *
 * The ONLY source of "randomness" in this module, and it is not random: the same
 * employee_code yields the same number in every process, so two runs cannot
 * disagree. Math.random / Date.now would each make the plan unreproducible,
 * which is the one thing a roster the owner argues about must never be.
 */
function stableSeed(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Trimmed string from any DB/body value. */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** Stable ascending comparator for the ids/codes we order by. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------------------------------------------ *
 * Internal row shapes
 * ------------------------------------------------------------------ */

interface EmpRow {
  id: string;
  employee_code: string;
  full_name: string;
  designation_id: string;
  designation_name: string;
  designation_active: number;
  status: string;
}

interface ShiftRow {
  id: string;
  name: string;
  start_hhmm: string;
  end_hhmm: string;
  split_json: string;
  is_active: number;
}

interface MapEntry {
  shift_role: string;
  weekday: number;
  shift_id: string;
  /** null when the map points at a shift that no longer exists. */
  shift: ShiftRow | null;
  /** true when the row came from a department_id='' default. */
  inherited: boolean;
}

interface CoverageRow {
  designation_id: string;
  weekday: number;
  shift_role: string;
  min_present: number;
  inherited: boolean;
}

/* ------------------------------------------------------------------ *
 * Split-shift invariant
 * ------------------------------------------------------------------ */

/** The [start, end] pairs of split_json, bad entries dropped (never a throw —
 *  same tolerance as hr-attendance.ts's shiftSpanMinutes). */
function parseSplitWindows(splitJson: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  try {
    const arr = JSON.parse(String(splitJson ?? '[]'));
    if (!Array.isArray(arr)) return out;
    for (const w of arr) {
      if (!Array.isArray(w) || w.length !== 2) continue;
      out.push([String(w[0]), String(w[1])]);
    }
  } catch {
    /* tolerated — an unparseable split_json simply has no windows */
  }
  return out;
}

/** The minimum a split-shift check needs to know about a shift. Deliberately
 *  narrower than ShiftRow so the shifts master route can validate a shift it is
 *  about to WRITE — a row that has no id yet. */
export interface SplitShiftCandidate {
  start_hhmm: string;
  end_hhmm: string;
  split_json: string;
}

/**
 * THE SPLIT-SHIFT INVARIANT. Returns a human description of the violation, or
 * null when the shift is stored correctly.
 *
 * EXPORTED ON PURPOSE, and it is the ONLY implementation. /api/hr/shifts calls
 * this same function so the manager is told at the point of entry instead of a
 * week later, and a second copy there would be the rival-helper trap: two
 * same-signature validators that agree today and silently diverge the first time
 * one of them is "improved".
 *
 * For a split shift the EARLIER window must be the MAIN one: MOR BREAK is
 * start_hhmm='11:00', end_hhmm='15:30' with the evening 18:30→closing window in
 * split_json — NOT the other way round.
 *
 * WHY THIS IS CHECKED AND NEVER QUIETLY CORRECTED: hr-attendance.ts computes
 * LATE from start_hhmm ALONE. Store the evening window as the main one and an
 * 11am start is compared against 18:30, so every single person on that shift
 * reads on-time forever — a guard that reads perfectly and never fires. Silently
 * swapping the columns here would instead rewrite the owner's shift master from
 * inside a roster run, which is his data to set. So: refuse, name the shift, and
 * state the correction.
 *
 * Minutes are normalised through the business-day cutoff before comparing, so a
 * genuinely overnight split (an evening main window with a post-midnight second
 * window) is not mistaken for a reversal.
 */
export function splitShiftInvariantProblem(
  shift: SplitShiftCandidate,
  cutoffMin: number,
): string | null {
  const windows = parseSplitWindows(shift.split_json);
  if (!windows.length) return null; // not a split shift — nothing to assert

  const norm = (m: number) => (m < cutoffMin ? m + 1440 : m);
  const mainStart = hhmmToMinutes(shift.start_hhmm);
  const mainEnd = hhmmToMinutes(shift.end_hhmm);
  if (mainStart === null || mainEnd === null) {
    return `its main window times are unparseable (start_hhmm='${shift.start_hhmm}', end_hhmm='${shift.end_hhmm}')`;
  }
  const mainStartN = norm(mainStart);
  for (const [ws, we] of windows) {
    const wsMin = hhmmToMinutes(ws);
    if (wsMin === null) {
      return `a split window has an unparseable start time ('${ws}')`;
    }
    if (norm(wsMin) <= mainStartN) {
      return (
        `the EARLIER window is in split_json, not in the main columns: ` +
        `main is ${shift.start_hhmm}-${shift.end_hhmm} but a split window starts at ${ws}` +
        `${we ? ` (ends ${we})` : ''}. LATE is computed from start_hhmm alone, so stored this ` +
        `way nobody on this shift can ever read late. Put the earlier window in ` +
        `start_hhmm/end_hhmm and the later one in split_json`
      );
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * generateRosterPlan — PURE
 * ------------------------------------------------------------------ */

/**
 * Plan one week for one department. Reads only; writes nothing, ever.
 *
 * The plan is the whole answer: assignments with a reason each, the coverage
 * measured against the owner's floors, the breaches, and the refusals. A caller
 * previews it, and only then hands the SAME object to commitRosterPlan.
 */
export function generateRosterPlan(db: Database.Database, input: RosterPlanInput): RosterPlan {
  const refusals: RosterRefusal[] = [];
  const warnings: string[] = [];

  const departmentId = s(input.department_id);
  const weekStart = s(input.week_start);

  /* ── Settings. Read BEFORE anything else so a what-if override is visible in
       the returned plan even when the plan itself refuses. ─────────────────── */
  const rotateShifts =
    typeof input.rotate_shifts === 'boolean' ? input.rotate_shifts : getHrRosterRotateShifts(db);
  const savedOffDays = getHrRosterOffsWeekdays(db);
  const overrideOffDays = Array.isArray(input.offs_weekdays)
    ? [...new Set(input.offs_weekdays.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort(
        (a, b) => a - b,
      )
    : [];
  // An empty override is "nobody chose", NOT "any day" — the one reading that
  // would put an off on Saturday night, the single thing the owner ruled out.
  const offsWeekdays = overrideOffDays.length ? overrideOffDays : savedOffDays;
  const weeklyOffPolicy = getHrWeeklyOffPolicy(db);
  const cutoffMin = hhmmToMinutes(getHrDayCutoff(db)) ?? 4 * 60;

  const blank = (deptName: string, dates: string[]): RosterPlan => ({
    ok: false,
    department_id: departmentId,
    department_name: deptName,
    week_start: weekStart,
    week_end: dates.length ? dates[dates.length - 1] : weekStart,
    dates,
    rotate_shifts: rotateShifts,
    offs_weekdays: offsWeekdays,
    weekly_off_policy: weeklyOffPolicy,
    previous_week_start: dates.length ? addDays(weekStart, -7) : '',
    groups: [],
    rows: [],
    coverage: [],
    breaches: [],
    refusals,
    warnings,
    shift_writes: [],
    off_writes: [],
  });

  if (!DATE_RE.test(weekStart)) {
    refusals.push({
      code: 'week_start_invalid',
      message: `week_start must be YYYY-MM-DD (got '${weekStart || '(empty)'}')`,
    });
    return blank('', []);
  }
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const weekEnd = dates[6];
  const prevStart = addDays(weekStart, -7);
  const prevEnd = addDays(weekStart, -1);

  /* ── Trap 1: the department is READ, never named. ─────────────────────────── */
  if (!departmentId) {
    const available = db
      .prepare(`SELECT id, name FROM departments WHERE is_active = 1 ORDER BY name, id`)
      .all() as Array<{ id: string; name: string }>;
    refusals.push({
      code: 'department_required',
      message: available.length
        ? `Choose a department to roster. ${available.length} active: ${available
            .slice(0, MAX_NAMED)
            .map((d) => d.name)
            .join(', ')}${available.length > MAX_NAMED ? ', …' : ''}`
        : 'Choose a department to roster — but no active department exists yet. Departments are set in the app; this generator never creates one.',
    });
    return blank('', dates);
  }
  const dept = db
    .prepare(`SELECT id, name, is_active FROM departments WHERE id = ?`)
    .get(departmentId) as { id: string; name: string; is_active: number } | undefined;
  if (!dept) {
    refusals.push({
      code: 'department_not_found',
      message:
        `No department with id '${departmentId}'. Departments are the owner's to set and are ` +
        `read from the master here — a roster keyed on a department NAME would configure a ` +
        `venue that does not exist (the local database still carries a legacy "Akan Service" ` +
        `department that production does not have)`,
      detail: { department_id: departmentId },
    });
    return blank('', dates);
  }
  const deptName = s(dept.name);
  if (!dept.is_active) {
    warnings.push(`Department "${deptName}" is marked inactive — rostering it anyway.`);
  }

  /* ── Employees of the department (main dept OR sub-dept — the same rule
       GET /api/hr/roster uses, so the two screens cannot disagree). ────────── */
  const allEmployees = db
    .prepare(
      `SELECT e.id, e.employee_code, e.full_name, e.designation_id, e.status,
              COALESCE(d.name, '')      AS designation_name,
              COALESCE(d.is_active, 0)  AS designation_active
         FROM hr_employees e
         LEFT JOIN hr_designations d ON d.id = e.designation_id
        WHERE (e.department_id = ? OR e.sub_department_id = ?)
        ORDER BY e.employee_code, e.id`,
    )
    .all(departmentId, departmentId) as EmpRow[];

  const exited = allEmployees.filter((e) => EXITED_STATUSES.has(s(e.status)));
  const employees = allEmployees.filter((e) => !EXITED_STATUSES.has(s(e.status)));
  if (exited.length) {
    warnings.push(
      `${exited.length} exited employee(s) in this department were skipped — they hold history but take no new roster.`,
    );
  }
  if (!employees.length) {
    refusals.push({
      code: 'no_employees',
      message:
        `No rosterable employee is assigned to "${deptName}" (as a main or sub department). ` +
        `Production measured 128 of 129 employees with NO department at all, so this is the ` +
        `usual starting point — classify them on /hr/employees first`,
      detail: { department_id: departmentId, department_name: deptName },
    });
    return blank(deptName, dates);
  }

  /* ── Groups ARE designations. No designation ⇒ no coverage group ⇒ refuse. ── */
  const noDesignation = employees.filter((e) => !s(e.designation_id));
  if (noDesignation.length) {
    refusals.push({
      code: 'employees_without_designation',
      message:
        `${noDesignation.length} employee(s) in "${deptName}" have no designation, and a ` +
        `designation IS the coverage group — without one there is nothing to hold a ` +
        `minimum-present floor against: ` +
        `${noDesignation.slice(0, MAX_NAMED).map((e) => e.employee_code || e.id).join(', ')}` +
        `${noDesignation.length > MAX_NAMED ? `, and ${noDesignation.length - MAX_NAMED} more` : ''}`,
      detail: { department_id: departmentId, count: noDesignation.length },
    });
  }
  const danglingDesignation = employees.filter(
    (e) => s(e.designation_id) && !s(e.designation_name),
  );
  if (danglingDesignation.length) {
    refusals.push({
      code: 'designation_not_found',
      message:
        `${danglingDesignation.length} employee(s) point at a designation that no longer ` +
        `exists in hr_designations: ` +
        `${danglingDesignation.slice(0, MAX_NAMED).map((e) => e.employee_code || e.id).join(', ')}`,
      detail: { count: danglingDesignation.length },
    });
  }
  const inactiveDesignation = employees.filter(
    (e) => s(e.designation_name) && !e.designation_active,
  );
  if (inactiveDesignation.length) {
    // Soft-deleted designation, real person — roster them and say so, rather
    // than refusing a week over a master-data tidy-up.
    warnings.push(
      `${inactiveDesignation.length} employee(s) hold a deactivated designation — rostered anyway.`,
    );
  }

  /* ── hr_shifts must exist at all (production: ZERO rows). ─────────────────── */
  const shiftCounts = db
    .prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active
                FROM hr_shifts`)
    .get() as { total: number; active: number | null };
  if (!shiftCounts.total) {
    refusals.push({
      code: 'no_shifts',
      message:
        'No shift templates exist (hr_shifts is empty). Create the shifts from the owner\'s own ' +
        'vocabulary on /hr/shifts first — MS, M 2 C, MOR BREAK (split 11:00-15:30 + 18:30-close), ' +
        'SECOND (14:30-close), NIGHT (18:30-03:30), plus the SUNDAY variants (MOR BREAK ' +
        '11:00-16:00 + 19:30-close, SECOND 14:00-close)',
    });
  } else if (!shiftCounts.active) {
    refusals.push({
      code: 'no_active_shifts',
      message: `All ${shiftCounts.total} shift template(s) are deactivated — nothing can be rostered.`,
    });
  }

  /* ── (shift_role, weekday) → hr_shifts.id. Trap 2: hr_shifts has NO weekday
       dimension, and SUNDAY TIMINGS DIFFER. The map is the only bridge, and an
       unmapped pair is a refusal — NEVER a fallthrough to the weekday template,
       which is exactly how Sunday's 19:30 silently becomes 18:30. ──────────── */
  const mapRows = db
    .prepare(
      `SELECT m.department_id, m.shift_role, m.weekday, m.shift_id,
              s.id AS s_id, s.name AS s_name, s.start_hhmm, s.end_hhmm,
              s.split_json, s.is_active
         FROM hr_roster_shift_map m
         LEFT JOIN hr_shifts s ON s.id = m.shift_id
        WHERE m.department_id = ? OR m.department_id = ''
        ORDER BY m.shift_role, m.weekday, m.department_id`,
    )
    .all(departmentId) as Array<Record<string, unknown>>;

  const shiftMap = new Map<string, MapEntry>();
  const mapKey = (role: string, weekday: number) => `${role}\u0000${weekday}`;
  // Two passes: the department_id='' defaults first, then this department's own
  // rows OVERWRITE them. More specific wins; '' is a default, not a rival.
  for (const inherited of [true, false]) {
    for (const r of mapRows) {
      const rowDept = s(r.department_id);
      if (inherited ? rowDept !== '' : rowDept !== departmentId) continue;
      const role = s(r.shift_role);
      const weekday = Number(r.weekday);
      if (!role || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;
      const sid = s(r.s_id);
      shiftMap.set(mapKey(role, weekday), {
        shift_role: role,
        weekday,
        shift_id: s(r.shift_id),
        shift: sid
          ? {
              id: sid,
              name: s(r.s_name),
              start_hhmm: s(r.start_hhmm),
              end_hhmm: s(r.end_hhmm),
              split_json: String(r.split_json ?? '[]'),
              is_active: Number(r.is_active) || 0,
            }
          : null,
        inherited,
      });
    }
  }

  /** The owner's configured role vocabulary FOR THIS DEPARTMENT, sorted so the
   *  rotation order is stable across runs and machines. */
  const roleUniverse = [...new Set([...shiftMap.values()].map((m) => m.shift_role))].sort(cmp);
  if (!roleUniverse.length) {
    refusals.push({
      code: 'no_shift_map',
      message:
        `No (shift role → shift) mapping exists for "${deptName}". hr_shifts carries no weekday ` +
        `dimension and the owner's SUNDAY timings differ, so every (role, weekday) must be ` +
        `mapped explicitly — there is deliberately no fallback to a weekday template`,
      detail: { department_id: departmentId, department_name: deptName },
    });
  }

  /* ── Coverage floors. MINIMUM PRESENT, never a max-offs cap. ──────────────── */
  const coverageRaw = db
    .prepare(
      `SELECT department_id, designation_id, weekday, shift_role, min_present
         FROM hr_roster_coverage
        WHERE department_id = ? OR department_id = ''
        ORDER BY designation_id, weekday, shift_role, department_id`,
    )
    .all(departmentId) as Array<Record<string, unknown>>;

  const coverage = new Map<string, CoverageRow>();
  const covKey = (desig: string, weekday: number, role: string) =>
    `${desig}\u0000${weekday}\u0000${role}`;
  for (const inherited of [true, false]) {
    for (const r of coverageRaw) {
      const rowDept = s(r.department_id);
      if (inherited ? rowDept !== '' : rowDept !== departmentId) continue;
      const weekday = Number(r.weekday);
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;
      const row: CoverageRow = {
        designation_id: s(r.designation_id),
        weekday,
        shift_role: s(r.shift_role),
        min_present: Math.max(0, Math.round(Number(r.min_present) || 0)),
        inherited,
      };
      coverage.set(covKey(row.designation_id, row.weekday, row.shift_role), row);
    }
  }
  if (!coverage.size) {
    refusals.push({
      code: 'no_coverage',
      message:
        `No coverage floor is configured for "${deptName}". Coverage is the owner's MINIMUM ` +
        `PRESENT per group per day — without it the generator has no way to know how many offs ` +
        `a day can carry, and guessing a number would quietly become a different promise every ` +
        `week. Set it on /hr/settings (one whole-department row per weekday is enough to start)`,
      detail: { department_id: departmentId },
    });
  }

  /* ── Group the employees. Stable order throughout: code, then id. ─────────── */
  const byDesignation = new Map<string, EmpRow[]>();
  for (const e of employees) {
    const key = s(e.designation_id);
    const list = byDesignation.get(key);
    if (list) list.push(e);
    else byDesignation.set(key, [e]);
  }
  const groupKeys = [...byDesignation.keys()].sort((a, b) => {
    const an = s(byDesignation.get(a)![0].designation_name);
    const bn = s(byDesignation.get(b)![0].designation_name);
    return cmp(an, bn) || cmp(a, b);
  });
  for (const k of groupKeys) {
    byDesignation
      .get(k)!
      .sort((a, b) => cmp(s(a.employee_code), s(b.employee_code)) || cmp(a.id, b.id));
  }
  const designationName = (id: string): string =>
    id ? s(byDesignation.get(id)?.[0]?.designation_name) || id : WHOLE_DEPARTMENT;

  /* ── A floor must RESOLVE for every group on every allowed off weekday ─────
       — those are the only days the generator makes a decision on, so those are
       the only days where a missing floor is a missing INPUT. On Fri/Sat/Sun no
       off can land, so nothing is needed there; a floor configured for those
       days is still MEASURED below (approved leave can breach one). ─────────── */
  const floorFor = (designationId: string, weekday: number, role: string): CoverageRow | null => {
    // Most specific first. Each step is a real, different promise.
    return (
      coverage.get(covKey(designationId, weekday, role)) ??
      coverage.get(covKey(designationId, weekday, '')) ??
      coverage.get(covKey('', weekday, role)) ??
      coverage.get(covKey('', weekday, '')) ??
      null
    );
  };
  if (coverage.size) {
    const weekWeekdays = new Set(dates.map(weekdayOf));
    const missingFloors: string[] = [];
    for (const gk of groupKeys) {
      for (const wd of offsWeekdays) {
        if (!weekWeekdays.has(wd)) continue;
        if (!floorFor(gk, wd, '')) {
          missingFloors.push(`${designationName(gk)} on ${WEEKDAY_NAMES[wd]}`);
        }
      }
    }
    if (missingFloors.length) {
      refusals.push({
        code: 'coverage_floor_missing',
        message:
          `No minimum-present floor resolves for ${missingFloors.length} group/day combination(s) ` +
          `that this week places offs on: ${missingFloors.slice(0, MAX_NAMED).join('; ')}` +
          `${missingFloors.length > MAX_NAMED ? `; and ${missingFloors.length - MAX_NAMED} more` : ''}. ` +
          `A whole-department day-total row covers a group that has no floor of its own`,
        detail: { count: missingFloors.length },
      });
    }
    // A floor naming a role that is not mapped can never be satisfied — the
    // people it counts cannot be put on that shift at all.
    const covRoles = [...new Set([...coverage.values()].map((c) => c.shift_role).filter(Boolean))];
    const unmappedCovRoles = covRoles.filter((role) => !roleUniverse.includes(role));
    if (unmappedCovRoles.length && roleUniverse.length) {
      refusals.push({
        code: 'coverage_role_unmapped',
        message:
          `Coverage names shift role(s) that have no (role, weekday) mapping in "${deptName}": ` +
          `${unmappedCovRoles.join(', ')}. The floor could never be met because nobody can be ` +
          `put on that shift`,
        detail: { roles: unmappedCovRoles.join(',') },
      });
    }
  }

  /* ── Approved leave BEATS EVERYTHING (owner rule 4). ──────────────────────── */
  const leaveByEmployee = new Map<string, Set<string>>();
  {
    const empIds = employees.map((e) => e.id);
    const ph = empIds.map(() => '?').join(',');
    const leaveRows = db
      .prepare(
        `SELECT employee_id, from_date, to_date
           FROM hr_leave_requests
          WHERE status = 'approved'
            AND from_date <= ? AND to_date >= ?
            AND employee_id IN (${ph})
          ORDER BY employee_id, from_date, id`,
      )
      .all(weekEnd, weekStart, ...empIds) as Array<{
      employee_id: string;
      from_date: string;
      to_date: string;
    }>;
    for (const l of leaveRows) {
      const set = leaveByEmployee.get(l.employee_id) ?? new Set<string>();
      for (const d of dates) {
        // Inclusive overlap in plain YYYY-MM-DD string space — lexical compare
        // IS date compare for this format, so no parsing can drift it.
        if (d >= s(l.from_date) && d <= s(l.to_date)) set.add(d);
      }
      if (set.size) leaveByEmployee.set(l.employee_id, set);
    }
  }
  const onLeave = (empId: string, date: string) => !!leaveByEmployee.get(empId)?.has(date);

  /* ── Previous week, for rotation. ─────────────────────────────────────────── */
  const prevRosterByEmployee = new Map<string, Map<string, string>>(); // emp → date → shift_id
  {
    const empIds = employees.map((e) => e.id);
    const ph = empIds.map(() => '?').join(',');
    const prevRows = db
      .prepare(
        `SELECT employee_id, date, shift_id
           FROM hr_rosters
          WHERE date >= ? AND date <= ? AND employee_id IN (${ph})
          ORDER BY employee_id, date`,
      )
      .all(prevStart, prevEnd, ...empIds) as Array<{
      employee_id: string;
      date: string;
      shift_id: string;
    }>;
    for (const r of prevRows) {
      const m = prevRosterByEmployee.get(r.employee_id) ?? new Map<string, string>();
      m.set(s(r.date), s(r.shift_id));
      prevRosterByEmployee.set(r.employee_id, m);
    }
  }
  /** shift_id → role, for reading last week's roster back. */
  const roleOfShift = new Map<string, string>();
  for (const m of shiftMap.values()) if (m.shift_id) roleOfShift.set(m.shift_id, m.shift_role);

  /**
   * Last week's off weekday for an employee, INFERRED.
   *
   * Offs are not persisted (owner decision), so the only evidence is the hole:
   * an allowed-off weekday on which the employee has no roster row, in a week
   * where they do have rows. The allowed set used is THIS week's — last week's
   * setting is not recorded anywhere, and the hard rule (Mon-Thu) has not moved.
   * null = no usable history, which is a first-run fact, not an error.
   */
  const prevOffWeekday = (empId: string): number | null => {
    const m = prevRosterByEmployee.get(empId);
    if (!m || m.size === 0) return null;
    for (const wd of offsWeekdays) {
      // Ascending weekday order makes a two-hole week resolve the same way twice.
      const d = dates.map((x) => addDays(x, -7)).find((x) => weekdayOf(x) === wd);
      if (d && !m.has(d)) return wd;
    }
    return null;
  };

  /** Last week's role for an employee: the most common one, ties by role name. */
  const prevRole = (empId: string): string | null => {
    const m = prevRosterByEmployee.get(empId);
    if (!m) return null;
    const counts = new Map<string, number>();
    for (const sid of m.values()) {
      const role = roleOfShift.get(sid);
      if (!role) continue;
      counts.set(role, (counts.get(role) ?? 0) + 1);
    }
    if (!counts.size) return null;
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0][0];
  };

  /* ── Role assignment: ONE role per employee per WEEK (the owner rotates
       people between shifts week over week, not day to day). ───────────────── */
  const roleByEmployee = new Map<string, string>();
  const roleReason = new Map<string, string>();
  if (roleUniverse.length) {
    for (const gk of groupKeys) {
      const members = byDesignation.get(gk)!;
      // The group's modal previous role — the documented fallback when ONE
      // member has no history but the group does.
      const groupCounts = new Map<string, number>();
      for (const e of members) {
        const r = prevRole(e.id);
        if (r) groupCounts.set(r, (groupCounts.get(r) ?? 0) + 1);
      }
      const groupModal =
        [...groupCounts.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]?.[0] ?? null;

      members.forEach((e, idx) => {
        const prev = prevRole(e.id);
        const prevUsable = prev && roleUniverse.includes(prev) ? prev : null;
        if (prev && !prevUsable) {
          warnings.push(
            `${e.employee_code || e.id} was on role "${prev}" last week, which is no longer mapped in this department — treated as no history.`,
          );
        }
        let role: string;
        let reason: string;
        if (!rotateShifts) {
          if (prevUsable) {
            role = prevUsable;
            reason = `shift: kept ${role}, rotation off`;
          } else if (groupModal && roleUniverse.includes(groupModal)) {
            role = groupModal;
            reason = `shift: ${role} — no personal history, group's usual role (rotation off)`;
          } else {
            // Spread by position, not by hash: a brand-new group must not land
            // every member on the same shift.
            role = roleUniverse[idx % roleUniverse.length];
            reason = `shift: ${role} — no history at all, seeded by group position (rotation off)`;
          }
        } else if (prevUsable) {
          // ONE step along the stable role order. Every member moves by the same
          // offset, so the week's role pattern is last week's, rotated — not a
          // reshuffle the owner would not recognise.
          role = roleUniverse[(roleUniverse.indexOf(prevUsable) + 1) % roleUniverse.length];
          reason = `shift: rotated ${prevUsable} → ${role}`;
        } else {
          role = roleUniverse[idx % roleUniverse.length];
          reason = `shift: ${role} — seeded by group position (no previous week)`;
        }
        roleByEmployee.set(e.id, role);
        roleReason.set(e.id, reason);
      });
    }
  }

  /* ── Off placement. ───────────────────────────────────────────────────────── */
  const offDateByEmployee = new Map<string, string>();
  const offReason = new Map<string, string>();
  const offsOnDate = new Map<string, Set<string>>(dates.map((d) => [d, new Set<string>()]));
  const groupOfEmployee = new Map<string, string>(
    employees.map((e) => [e.id, s(e.designation_id)]),
  );

  /** How many of a scope are PRESENT on a date under the current decisions. */
  const presentCount = (date: string, designationId: string, role: string): number => {
    let n = 0;
    for (const e of employees) {
      if (designationId && groupOfEmployee.get(e.id) !== designationId) continue;
      if (role && roleByEmployee.get(e.id) !== role) continue;
      if (onLeave(e.id, date)) continue;
      if (offsOnDate.get(date)?.has(e.id)) continue;
      n++;
    }
    return n;
  };

  /** Would an off for `emp` on `date` drop any floor that COUNTS them below it? */
  const keepsEveryFloor = (empId: string, date: string): boolean => {
    const wd = weekdayOf(date);
    const desig = groupOfEmployee.get(empId) ?? '';
    const role = roleByEmployee.get(empId) ?? '';
    for (const c of coverage.values()) {
      if (c.weekday !== wd) continue;
      if (c.designation_id && c.designation_id !== desig) continue; // doesn't count them
      if (c.shift_role && c.shift_role !== role) continue;
      if (presentCount(date, c.designation_id, c.shift_role) - 1 < c.min_present) return false;
    }
    return true;
  };

  // INTERLEAVED order: the 1st member of every group, then the 2nd, and so on.
  // Processing group-by-group would let the first designation take all of
  // Monday's capacity and leave the last one nothing but breaches.
  const placementOrder: EmpRow[] = [];
  {
    const maxLen = Math.max(0, ...groupKeys.map((k) => byDesignation.get(k)!.length));
    for (let i = 0; i < maxLen; i++) {
      for (const gk of groupKeys) {
        const e = byDesignation.get(gk)![i];
        if (e) placementOrder.push(e);
      }
    }
  }

  for (const e of placementOrder) {
    const candidates = dates.filter(
      (d) => offsWeekdays.includes(weekdayOf(d)) && !onLeave(e.id, d),
    );
    if (!candidates.length) {
      const leaveDays = leaveByEmployee.get(e.id)?.size ?? 0;
      warnings.push(
        leaveDays
          ? `${e.employee_code || e.id} has approved leave on every allowed off day this week — no weekly off placed (leave already blanks the row).`
          : `${e.employee_code || e.id}: no allowed off weekday falls in this week — no weekly off placed.`,
      );
      continue;
    }

    const prevWd = prevOffWeekday(e.id);
    const desig = groupOfEmployee.get(e.id) ?? '';
    // Seeded rotation of the allowed-day order: a deterministic per-person
    // starting point, so two people with identical history and load still
    // spread instead of both taking the first allowed day.
    const seed = stableSeed(s(e.employee_code) || e.id);
    const rotatedOrder = offsWeekdays.map(
      (_, i) => offsWeekdays[(i + (seed % offsWeekdays.length)) % offsWeekdays.length],
    );
    const rotationRank = (wd: number) => {
      const i = rotatedOrder.indexOf(wd);
      return i < 0 ? offsWeekdays.length : i;
    };

    const scored = candidates
      .map((d) => {
        const offs = offsOnDate.get(d)!;
        let groupLoad = 0;
        for (const id of offs) if (groupOfEmployee.get(id) === desig) groupLoad++;
        return {
          date: d,
          feasible: keepsEveryFloor(e.id, d) ? 0 : 1,
          repeatsPrev: prevWd !== null && weekdayOf(d) === prevWd ? 1 : 0,
          groupLoad,
          deptLoad: offs.size,
          rank: rotationRank(weekdayOf(d)),
        };
      })
      .sort(
        (a, b) =>
          a.feasible - b.feasible ||
          a.repeatsPrev - b.repeatsPrev ||
          a.groupLoad - b.groupLoad ||
          a.deptLoad - b.deptLoad ||
          a.rank - b.rank ||
          cmp(a.date, b.date),
      );

    // RULE 4 IS NOT NEGOTIABLE: one weekly off each. When no allowed day has
    // capacity we still place the off on the least-bad day and let the coverage
    // pass below name the breach — a floor is the owner's business promise, and
    // silently cancelling someone's rest day to protect it is the one outcome
    // nobody asked for.
    const pick = scored[0];
    offDateByEmployee.set(e.id, pick.date);
    offsOnDate.get(pick.date)!.add(e.id);
    const wdName = WEEKDAY_NAMES[weekdayOf(pick.date)];
    let reason: string;
    if (prevWd === null) {
      reason = `off: ${wdName} — spread across allowed days (no previous week)`;
    } else if (pick.repeatsPrev) {
      reason = `off: ${wdName} again — no other allowed day had capacity`;
    } else {
      reason = `off: rotated from ${WEEKDAY_NAMES[prevWd]} last week to ${wdName}`;
    }
    if (pick.feasible) {
      reason += ' (coverage floor breached — no allowed day had capacity)';
    }
    offReason.set(e.id, reason);
  }

  /* ── Resolve every needed (role, weekday) → shift, and validate the split
       invariant on each shift we would actually roster onto. ───────────────── */
  const neededPairs = new Map<string, { role: string; weekday: number }>();
  for (const e of employees) {
    const role = roleByEmployee.get(e.id);
    if (!role) continue;
    for (const d of dates) {
      if (onLeave(e.id, d)) continue;
      if (offDateByEmployee.get(e.id) === d) continue;
      const wd = weekdayOf(d);
      neededPairs.set(mapKey(role, wd), { role, weekday: wd });
    }
  }
  const missingPairs: string[] = [];
  const danglingPairs: string[] = [];
  const inactivePairs: string[] = [];
  const splitProblems: string[] = [];
  const seenSplitChecks = new Set<string>();
  for (const [key, { role, weekday }] of [...neededPairs.entries()].sort((a, b) =>
    cmp(a[0], b[0]),
  )) {
    const entry = shiftMap.get(key);
    if (!entry) {
      missingPairs.push(`${role} on ${WEEKDAY_NAMES[weekday]}`);
      continue;
    }
    if (!entry.shift) {
      danglingPairs.push(`${role} on ${WEEKDAY_NAMES[weekday]} → shift id '${entry.shift_id}'`);
      continue;
    }
    if (!entry.shift.is_active) {
      inactivePairs.push(`${role} on ${WEEKDAY_NAMES[weekday]} → "${entry.shift.name}"`);
      continue;
    }
    if (!seenSplitChecks.has(entry.shift.id)) {
      seenSplitChecks.add(entry.shift.id);
      const problem = splitShiftInvariantProblem(entry.shift, cutoffMin);
      if (problem) splitProblems.push(`"${entry.shift.name}": ${problem}`);
    }
  }
  if (missingPairs.length) {
    refusals.push({
      code: 'shift_map_missing',
      message:
        `No (role, weekday) → shift mapping for ${missingPairs.length} combination(s) this week ` +
        `needs: ${missingPairs.slice(0, MAX_NAMED).join('; ')}` +
        `${missingPairs.length > MAX_NAMED ? `; and ${missingPairs.length - MAX_NAMED} more` : ''}. ` +
        `There is deliberately NO fallback to another weekday — substituting one is how ` +
        `Sunday's 19:30 start silently becomes the weekday 18:30 and staff turn up ninety ` +
        `minutes early`,
      detail: { count: missingPairs.length },
    });
  }
  if (danglingPairs.length) {
    refusals.push({
      code: 'shift_map_dangling',
      message: `The shift map points at shift(s) that no longer exist: ${danglingPairs
        .slice(0, MAX_NAMED)
        .join('; ')}`,
      detail: { count: danglingPairs.length },
    });
  }
  if (inactivePairs.length) {
    refusals.push({
      code: 'shift_inactive',
      message:
        `The shift map points at deactivated shift(s): ${inactivePairs.slice(0, MAX_NAMED).join('; ')}. ` +
        `A generated week is a NEW intent and must target live templates (an existing manual ` +
        `assignment to a since-deactivated shift is still tolerated)`,
      detail: { count: inactivePairs.length },
    });
  }
  if (splitProblems.length) {
    refusals.push({
      code: 'split_shift_reversed',
      message:
        `Split-shift invariant violated — fix the shift, this generator will not silently ` +
        `rewrite the owner's shift master: ${splitProblems.join('; ')}`,
      detail: { count: splitProblems.length },
    });
  }

  /* ── Build the rows (one per employee per date). ──────────────────────────── */
  const rows: RosterPlanRow[] = [];
  const shiftWrites: RosterShiftWrite[] = [];
  const offWrites: RosterOffWrite[] = [];
  for (const gk of groupKeys) {
    for (const e of byDesignation.get(gk)!) {
      const role = roleByEmployee.get(e.id) ?? '';
      for (const d of dates) {
        const wd = weekdayOf(d);
        const base = {
          employee_id: e.id,
          employee_code: s(e.employee_code),
          employee_name: s(e.full_name),
          designation_id: s(e.designation_id),
          designation_name: s(e.designation_name),
          date: d,
          weekday: wd,
        };
        if (onLeave(e.id, d)) {
          rows.push({
            ...base,
            kind: 'leave',
            shift_role: '',
            shift_id: '',
            shift_name: '',
            reason: 'leave: approved leave blanks the row and overrides everything',
          });
          continue;
        }
        if (offDateByEmployee.get(e.id) === d) {
          rows.push({
            ...base,
            kind: 'off',
            shift_role: '',
            shift_id: '',
            shift_name: '',
            reason: offReason.get(e.id) ?? 'off: weekly off',
          });
          offWrites.push({ employee_id: e.id, date: d });
          continue;
        }
        const entry = shiftMap.get(mapKey(role, wd));
        rows.push({
          ...base,
          kind: 'shift',
          shift_role: role,
          shift_id: entry?.shift?.id ?? '',
          shift_name: entry?.shift?.name ?? '',
          reason: roleReason.get(e.id) ?? 'shift: assigned',
        });
        if (entry?.shift?.id) {
          shiftWrites.push({ employee_id: e.id, date: d, shift_id: entry.shift.id, note: role });
        }
      }
    }
  }

  /* ── Measure every floor against the finished plan. ───────────────────────── */
  const coverageLines: RosterCoverageLine[] = [];
  const breaches: RosterBreach[] = [];
  const presentDesignations = new Set(groupKeys);
  for (const d of dates) {
    const wd = weekdayOf(d);
    const applicable = [...coverage.values()]
      .filter((c) => c.weekday === wd)
      .sort((a, b) => cmp(a.designation_id, b.designation_id) || cmp(a.shift_role, b.shift_role));
    for (const c of applicable) {
      if (c.designation_id && !presentDesignations.has(c.designation_id)) {
        // A floor for a designation with nobody in THIS department. Almost
        // always a department_id='' default meant for another department —
        // reporting it as a breach would bury the real ones in noise.
        continue;
      }
      let offCount = 0;
      let leaveCount = 0;
      for (const e of employees) {
        if (c.designation_id && groupOfEmployee.get(e.id) !== c.designation_id) continue;
        if (c.shift_role && roleByEmployee.get(e.id) !== c.shift_role) continue;
        if (onLeave(e.id, d)) leaveCount++;
        else if (offDateByEmployee.get(e.id) === d) offCount++;
      }
      const present = presentCount(d, c.designation_id, c.shift_role);
      const shortfall = Math.max(0, c.min_present - present);
      const group = designationName(c.designation_id);
      coverageLines.push({
        date: d,
        weekday: wd,
        designation_id: c.designation_id,
        group,
        shift_role: c.shift_role,
        min_present: c.min_present,
        planned_present: present,
        shortfall,
        off_count: offCount,
        leave_count: leaveCount,
      });
      if (shortfall > 0) {
        const scope = c.shift_role ? `${group} on ${c.shift_role}` : `${group} (day total)`;
        breaches.push({
          date: d,
          weekday: wd,
          designation_id: c.designation_id,
          group,
          shift_role: c.shift_role,
          min_present: c.min_present,
          planned_present: present,
          shortfall,
          message:
            `${scope}: ${WEEKDAY_NAMES[wd]} ${d} needs ${c.min_present} present, plan has ` +
            `${present} (short by ${shortfall}; ${offCount} off, ${leaveCount} on approved leave)`,
        });
      }
    }
  }

  /* ── Report. ──────────────────────────────────────────────────────────────── */
  const groups: RosterPlanGroup[] = groupKeys.map((gk) => {
    const members = byDesignation.get(gk)!;
    const roleCounts: Record<string, number> = {};
    for (const e of members) {
      const r = roleByEmployee.get(e.id) ?? '';
      if (!r) continue;
      roleCounts[r] = (roleCounts[r] ?? 0) + 1;
    }
    const offsByDate: Record<string, number> = {};
    for (const d of dates) {
      let n = 0;
      for (const e of members) if (offDateByEmployee.get(e.id) === d) n++;
      offsByDate[d] = n;
    }
    return {
      designation_id: gk,
      designation_name: designationName(gk),
      employee_count: members.length,
      role_counts: roleCounts,
      offs_by_date: offsByDate,
    };
  });

  const ok = refusals.length === 0;
  return {
    ok,
    department_id: departmentId,
    department_name: deptName,
    week_start: weekStart,
    week_end: weekEnd,
    dates,
    rotate_shifts: rotateShifts,
    offs_weekdays: offsWeekdays,
    weekly_off_policy: weeklyOffPolicy,
    previous_week_start: prevStart,
    groups,
    // NEVER A HALF-PLAN. With a refusal standing, the rows would be partly
    // unresolved (a missing map entry leaves shift_id ''), and a UI showing
    // them would look like a roster. Refusals are the whole answer instead.
    rows: ok ? rows : [],
    coverage: ok ? coverageLines : [],
    breaches: ok ? breaches : [],
    refusals,
    warnings,
    shift_writes: ok ? shiftWrites : [],
    off_writes: ok ? offWrites : [],
  };
}

/* ------------------------------------------------------------------ *
 * commitRosterPlan — the ONLY write path
 * ------------------------------------------------------------------ */

export interface RosterCommitOptions {
  /** Commit a plan that names coverage breaches. Off by default: a breach is a
   *  promise the owner made being broken, and it must be acknowledged, not
   *  stumbled past. */
  allow_breaches?: boolean;
}

/**
 * Write a plan's SHIFT rows to hr_rosters in ONE transaction.
 *
 * Offs are NOT written as roster rows (owner decision — see the header). Under
 * hr_weekly_off_policy='paid' each off becomes an hr_attendance row with status
 * WEEKLY_OFF instead.
 *
 * A MANUAL EDIT WINS. Rows whose hr_rosters.source is not 'generated' — which
 * includes every row written before that column existed — are left exactly as
 * they are and reported in kept_manual. The upsert also carries that test in
 * SQL, so even a stale pre-read cannot clobber a human's work.
 *
 * better-sqlite3 is synchronous: there is no await anywhere below the
 * transaction, and the caller resolves its session/outlet BEFORE calling.
 */
export function commitRosterPlan(
  db: Database.Database,
  plan: RosterPlan,
  actor: { email: string; outlet_id?: string | null },
  options: RosterCommitOptions = {},
): RosterCommitResult {
  const empty: RosterCommitResult = {
    ok: false,
    shift_rows_written: 0,
    stale_rows_removed: 0,
    kept_manual: [],
    weekly_off_rows_written: 0,
    weekly_off_rows_skipped: [],
  };

  if (!plan.ok || plan.refusals.length) {
    return {
      ...empty,
      error: `Cannot commit — the plan was refused: ${plan.refusals.map((r) => r.code).join(', ')}`,
    };
  }
  if (!plan.shift_writes.length) {
    // Trap 4 again, on the write side: a blank week must never be committed as
    // though it were a roster.
    return { ...empty, error: 'Cannot commit — the plan contains no shift assignments' };
  }
  if (plan.breaches.length && !options.allow_breaches) {
    return {
      ...empty,
      error:
        `Cannot commit — ${plan.breaches.length} coverage breach(es) are unacknowledged: ` +
        `${plan.breaches[0].message}${plan.breaches.length > 1 ? ' (and more)' : ''}`,
    };
  }

  // The provenance column must exist before we can honour "a manual edit wins".
  // Asserting it beats discovering it as a "no such column" 500 mid-transaction.
  const rosterCols = db.prepare(`PRAGMA table_info(hr_rosters)`).all() as Array<{ name: string }>;
  if (!rosterCols.some((c) => c.name === 'source')) {
    return {
      ...empty,
      error:
        'Cannot commit — hr_rosters.source is missing, so a generated row cannot be told from a ' +
        "manual one and a re-run could overwrite a manager's edit",
    };
  }

  const { week_start: weekStart, week_end: weekEnd } = plan;
  const employeeIds = [...new Set(plan.rows.map((r) => r.employee_id))];
  if (!employeeIds.length) return { ...empty, error: 'Cannot commit — the plan has no employees' };

  const empPh = employeeIds.map(() => '?').join(',');

  /* ── Pre-reads (outside the transaction — nothing here decides to write). ─── */
  const existingRoster = db
    .prepare(
      `SELECT employee_id, date, COALESCE(source, '') AS source
         FROM hr_rosters
        WHERE date >= ? AND date <= ? AND employee_id IN (${empPh})`,
    )
    .all(weekStart, weekEnd, ...employeeIds) as Array<{
    employee_id: string;
    date: string;
    source: string;
  }>;
  const sourceByKey = new Map(
    existingRoster.map((r) => [`${r.employee_id}\u0000${r.date}`, r.source]),
  );

  const kept_manual: Array<{ employee_id: string; date: string }> = [];
  const writes = plan.shift_writes.filter((w) => {
    const src = sourceByKey.get(`${w.employee_id}\u0000${w.date}`);
    if (src !== undefined && src !== ROSTER_SOURCE_GENERATED) {
      kept_manual.push({ employee_id: w.employee_id, date: w.date });
      return false;
    }
    return true;
  });

  // A day that WAS a generated shift and is now an off or a leave day must lose
  // its row, or last run's shift lingers on a rest day and reads as a real
  // assignment (and, via hr-attendance-register, as an absence).
  const writeKeys = new Set(plan.shift_writes.map((w) => `${w.employee_id}\u0000${w.date}`));
  const stale = existingRoster.filter(
    (r) => r.source === ROSTER_SOURCE_GENERATED && !writeKeys.has(`${r.employee_id}\u0000${r.date}`),
  );

  const offWrites = plan.weekly_off_policy === 'paid' ? plan.off_writes : [];
  const weekly_off_rows_skipped: RosterCommitResult['weekly_off_rows_skipped'] = [];
  const offInserts: RosterOffWrite[] = [];
  if (offWrites.length) {
    const existingAtt = db
      .prepare(
        `SELECT employee_id, date, status
           FROM hr_attendance
          WHERE date >= ? AND date <= ? AND employee_id IN (${empPh})`,
      )
      .all(weekStart, weekEnd, ...employeeIds) as Array<{
      employee_id: string;
      date: string;
      status: string;
    }>;
    const attByKey = new Map(
      existingAtt.map((r) => [`${r.employee_id}\u0000${r.date}`, s(r.status)]),
    );
    for (const o of offWrites) {
      const existing = attByKey.get(`${o.employee_id}\u0000${o.date}`);
      // A REAL PUNCH IS NEVER OVERWRITTEN. Someone who came in on their off day
      // keeps their computed attendance; we only fill an empty day.
      if (existing !== undefined) {
        weekly_off_rows_skipped.push({ ...o, existing_status: existing });
        continue;
      }
      offInserts.push(o);
    }
  }

  const outletId = s(actor.outlet_id ?? '');
  let shiftRowsWritten = 0;
  let staleRemoved = 0;
  let offRowsWritten = 0;

  const upsert = db.prepare(
    `INSERT INTO hr_rosters (id, employee_id, date, shift_id, note, created_by, source)
     VALUES (?, ?, ?, ?, ?, ?, '${ROSTER_SOURCE_GENERATED}')
     ON CONFLICT(employee_id, date) DO UPDATE SET
       shift_id   = excluded.shift_id,
       note       = excluded.note,
       created_by = excluded.created_by,
       source     = excluded.source
     WHERE hr_rosters.source = '${ROSTER_SOURCE_GENERATED}'`,
  );
  const delStale = db.prepare(
    `DELETE FROM hr_rosters
      WHERE employee_id = ? AND date = ? AND source = '${ROSTER_SOURCE_GENERATED}'`,
  );
  const insOff = db.prepare(
    `INSERT INTO hr_attendance (id, employee_id, outlet_id, date, status)
     VALUES (?, ?, ?, ?, 'WEEKLY_OFF')
     ON CONFLICT(employee_id, date) DO NOTHING`,
  );

  const run = db.transaction(() => {
    for (const w of writes) {
      shiftRowsWritten += upsert.run(
        generateId(),
        w.employee_id,
        w.date,
        w.shift_id,
        w.note,
        actor.email,
      ).changes;
    }
    for (const r of stale) {
      staleRemoved += delStale.run(r.employee_id, r.date).changes;
    }
    for (const o of offInserts) {
      offRowsWritten += insOff.run(generateId(), o.employee_id, outletId, o.date).changes;
    }
    // ONE summary event, not one per row — hr_rosters is the state, and a
    // 700-row week must not take 700 audit writes (the bulk roster route's rule).
    logAuditEvent(db, {
      event_type: 'hr.roster.generate_commit',
      entity_type: 'hr_roster',
      entity_id: `generate:${plan.department_id}:${weekStart}..${weekEnd}`,
      actor_email: actor.email,
      outlet_id: outletId || null,
      after: {
        department_id: plan.department_id,
        department_name: plan.department_name,
        week_start: weekStart,
        week_end: weekEnd,
        rotate_shifts: plan.rotate_shifts,
        offs_weekdays: plan.offs_weekdays.join(','),
        weekly_off_policy: plan.weekly_off_policy,
        employees: employeeIds.length,
        shift_rows: shiftRowsWritten,
        stale_rows_removed: staleRemoved,
        kept_manual: kept_manual.length,
        weekly_off_rows: offRowsWritten,
        breaches: plan.breaches.length,
        breaches_acknowledged: !!options.allow_breaches,
      },
    });
  });
  run();

  return {
    ok: true,
    shift_rows_written: shiftRowsWritten,
    stale_rows_removed: staleRemoved,
    kept_manual,
    weekly_off_rows_written: offRowsWritten,
    weekly_off_rows_skipped,
  };
}
