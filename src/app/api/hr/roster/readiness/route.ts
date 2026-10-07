import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canManageHr } from '@/lib/hr';
import { generateRosterPlan } from '@/lib/hr-roster-generate';
import { todayIST } from '@/lib/format-date';
import { reportServerError } from '@/lib/error-alerts';

/**
 * ROSTER READINESS (/api/hr/roster/readiness) — HRMS roster Stage 3.
 *
 * GET ?week_start=YYYY-MM-DD → { week_start, global, departments: [...] }
 *
 * WHY THIS ROUTE EXISTS. Production measured 2026-10-06: 129 employees on rolls,
 * 128 with NO department, ZERO hr_shifts, ZERO hr_rosters rows ever. So the
 * ordinary answer to "generate next week" is a REFUSAL, and a manager staring at
 * an empty grid has no way to learn that from the grid. This endpoint states, per
 * department and in plain numbers, what exists and what is missing.
 *
 * THE VERDICT IS THE GENERATOR'S OWN. Every department's verdict comes from
 * generateRosterPlan — the same pure function POST /api/hr/roster/generate calls
 * — never from a second set of "is it configured?" checks written here. A
 * parallel readiness rule is precisely how a panel comes to say READY about a
 * week that then refuses, and this repo already carries scars from guards that
 * read correctly and never fire. generateRosterPlan writes nothing, so calling
 * it per department is free of side effects.
 *
 * NO DEPARTMENT NAME IS HARDCODED, here or anywhere below. Departments are the
 * owner's master and are READ: the stale local database still carries a legacy
 * "Akan Service" department that production does not have, so anything keyed on
 * a name would describe a venue that does not exist.
 *
 * Gated on canManageHr — the same predicate the roster grid and the generator
 * use. This verb re-authenticates: the proxy does NOT guard API routes (§2.1).
 */
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Trimmed string from any DB value. */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** The Monday of the week containing `date`. Same rule as /hr/roster's own
 *  mondayOf() and the generator route's, so the three cannot land on different
 *  weeks. Pure YYYY-MM-DD / UTC arithmetic — no timezone drift. */
function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Statuses that hold history but take no new roster (the generator's own set). */
const EXITED = `('resigned','terminated','former')`;

/**
 * How many departments get a full plan computed. Production has 15; the cap only
 * exists so a pathological master cannot turn one page load into hundreds of
 * plans. Departments past the cap are still LISTED with their counts and say
 * plainly that their verdict was not computed — never a guessed "ready".
 */
const MAX_PLANNED_DEPARTMENTS = 40;

interface DeptReadiness {
  department_id: string;
  department_name: string;
  parent_id: string;
  is_active: number;
  /** Rosterable (non-exited) people whose main OR sub department is this one. */
  on_rolls: number;
  /** ...of whom carry no designation — a designation IS the coverage group. */
  without_designation: number;
  /** Distinct designations present among those people. */
  designations: number;
  /** Active hr_shifts rows usable by this department (its own + the shared ''). */
  active_shifts: number;
  /** hr_roster_shift_map rows that apply (own + inherited ''). */
  shift_map_rows: number;
  /** Distinct shift roles mapped, and how many of the 7 weekdays each covers. */
  shift_roles: number;
  /** (role, weekday) pairs still unmapped across the mapped roles — SUNDAY INCLUDED. */
  shift_map_gaps: number;
  /** hr_roster_coverage rows that apply (own + inherited ''). */
  coverage_rows: number;
  /** 'ready' | 'blocked' | 'not_measured' */
  verdict: 'ready' | 'blocked' | 'not_measured';
  /** The generator's refusals, verbatim — already written for a human. */
  refusals: Array<{ code: string; message: string }>;
  /** Honest degradations that are not blockers. */
  warnings: string[];
  /** Coverage floors this week's plan could not keep (only when verdict='ready'). */
  breaches: number;
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    const url = new URL(request.url);
    const rawWeek = s(url.searchParams.get('week_start'));
    if (rawWeek && !DATE_RE.test(rawWeek)) {
      return Response.json({ error: 'Invalid week_start (expected YYYY-MM-DD)' }, { status: 400 });
    }
    const weekStart = mondayOf(rawWeek || todayIST());

    const db = getDb();

    /* ── Venue-wide facts. These are the numbers that make the usual refusal
         make sense: "128 of 129 have no department" is the whole story. ────── */
    const emp = db
      .prepare(
        `SELECT COUNT(*) AS on_rolls,
                SUM(CASE WHEN TRIM(COALESCE(department_id, '')) = ''
                          AND TRIM(COALESCE(sub_department_id, '')) = ''
                         THEN 1 ELSE 0 END) AS no_department,
                SUM(CASE WHEN TRIM(COALESCE(designation_id, '')) = '' THEN 1 ELSE 0 END)
                  AS no_designation
           FROM hr_employees
          WHERE status NOT IN ${EXITED}`,
      )
      .get() as { on_rolls: number; no_department: number | null; no_designation: number | null };

    const shiftTotals = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active
           FROM hr_shifts`,
      )
      .get() as { total: number; active: number | null };

    const rosterTotal = db.prepare(`SELECT COUNT(*) AS n FROM hr_rosters`).get() as { n: number };

    const departments = db
      .prepare(
        `SELECT id, name, COALESCE(parent_id, '') AS parent_id, is_active
           FROM departments
          ORDER BY is_active DESC, name COLLATE NOCASE ASC, id ASC`,
      )
      .all() as Array<{ id: string; name: string; parent_id: string; is_active: number }>;

    /* ── Per-department counts, in bulk. One grouped query each rather than four
         queries per department, so 15 departments stay one page load. ──────── */
    const countBy = (sql: string, ...args: unknown[]) => {
      const rows = db.prepare(sql).all(...args) as Array<{ k: string; n: number }>;
      const m = new Map<string, number>();
      for (const r of rows) m.set(s(r.k), Number(r.n) || 0);
      return m;
    };

    // An employee counts towards BOTH their main and their sub department — the
    // same OR rule the generator and GET /api/hr/roster use, so the panel's
    // headcount matches the grid's.
    const onRolls = countBy(
      `SELECT k, COUNT(DISTINCT id) AS n FROM (
         SELECT TRIM(COALESCE(department_id, '')) AS k, id FROM hr_employees
          WHERE status NOT IN ${EXITED} AND TRIM(COALESCE(department_id, '')) <> ''
         UNION
         SELECT TRIM(COALESCE(sub_department_id, '')) AS k, id FROM hr_employees
          WHERE status NOT IN ${EXITED} AND TRIM(COALESCE(sub_department_id, '')) <> ''
       ) GROUP BY k`,
    );
    const noDesig = countBy(
      `SELECT k, COUNT(DISTINCT id) AS n FROM (
         SELECT TRIM(COALESCE(department_id, '')) AS k, id FROM hr_employees
          WHERE status NOT IN ${EXITED} AND TRIM(COALESCE(designation_id, '')) = ''
            AND TRIM(COALESCE(department_id, '')) <> ''
         UNION
         SELECT TRIM(COALESCE(sub_department_id, '')) AS k, id FROM hr_employees
          WHERE status NOT IN ${EXITED} AND TRIM(COALESCE(designation_id, '')) = ''
            AND TRIM(COALESCE(sub_department_id, '')) <> ''
       ) GROUP BY k`,
    );
    const desigCount = countBy(
      `SELECT k, COUNT(DISTINCT designation_id) AS n FROM (
         SELECT TRIM(COALESCE(department_id, '')) AS k, TRIM(COALESCE(designation_id, '')) AS designation_id
           FROM hr_employees
          WHERE status NOT IN ${EXITED} AND TRIM(COALESCE(designation_id, '')) <> ''
            AND TRIM(COALESCE(department_id, '')) <> ''
         UNION
         SELECT TRIM(COALESCE(sub_department_id, '')) AS k, TRIM(COALESCE(designation_id, '')) AS designation_id
           FROM hr_employees
          WHERE status NOT IN ${EXITED} AND TRIM(COALESCE(designation_id, '')) <> ''
            AND TRIM(COALESCE(sub_department_id, '')) <> ''
       ) GROUP BY k`,
    );
    const ownShifts = countBy(
      `SELECT TRIM(COALESCE(department_id, '')) AS k, COUNT(*) AS n
         FROM hr_shifts WHERE is_active = 1 GROUP BY k`,
    );
    const coverageRows = countBy(
      `SELECT TRIM(COALESCE(department_id, '')) AS k, COUNT(*) AS n
         FROM hr_roster_coverage GROUP BY k`,
    );

    // The shift map needs its (role, weekday) shape, not just a count: a map
    // with every role present but Sunday missing is the exact failure the
    // weekday dimension exists to prevent, so the gap is counted explicitly.
    const mapRows = db
      .prepare(
        `SELECT TRIM(COALESCE(department_id, '')) AS dept, shift_role, weekday
           FROM hr_roster_shift_map`,
      )
      .all() as Array<{ dept: string; shift_role: string; weekday: number }>;
    const mapByDept = new Map<string, Array<{ role: string; weekday: number }>>();
    for (const r of mapRows) {
      const role = s(r.shift_role);
      const wd = Number(r.weekday);
      if (!role || !Number.isInteger(wd) || wd < 0 || wd > 6) continue;
      const list = mapByDept.get(s(r.dept));
      if (list) list.push({ role, weekday: wd });
      else mapByDept.set(s(r.dept), [{ role, weekday: wd }]);
    }

    /** Own rows OVERRIDE the shared '' defaults — more specific wins, exactly as
     *  generateRosterPlan resolves them. */
    const mapShapeFor = (deptId: string) => {
      const pairs = new Map<string, boolean>();
      const roles = new Set<string>();
      for (const scope of ['', deptId]) {
        for (const e of mapByDept.get(scope) ?? []) {
          pairs.set(`${e.role}\u0000${e.weekday}`, true);
          roles.add(e.role);
        }
      }
      let gaps = 0;
      for (const role of roles) {
        for (let wd = 0; wd <= 6; wd++) if (!pairs.has(`${role}\u0000${wd}`)) gaps++;
      }
      return { rows: pairs.size, roles: roles.size, gaps };
    };

    const sharedShifts = ownShifts.get('') ?? 0;
    const sharedCoverage = coverageRows.get('') ?? 0;

    const out: DeptReadiness[] = [];
    let planned = 0;
    for (const d of departments) {
      const id = s(d.id);
      const shape = mapShapeFor(id);
      const row: DeptReadiness = {
        department_id: id,
        department_name: s(d.name),
        parent_id: s(d.parent_id),
        is_active: Number(d.is_active) || 0,
        on_rolls: onRolls.get(id) ?? 0,
        without_designation: noDesig.get(id) ?? 0,
        designations: desigCount.get(id) ?? 0,
        // A shift with department_id '' is usable everywhere, so it counts here.
        active_shifts: (ownShifts.get(id) ?? 0) + sharedShifts,
        shift_map_rows: shape.rows,
        shift_roles: shape.roles,
        shift_map_gaps: shape.gaps,
        coverage_rows: (coverageRows.get(id) ?? 0) + sharedCoverage,
        verdict: 'not_measured',
        refusals: [],
        warnings: [],
        breaches: 0,
      };

      if (planned < MAX_PLANNED_DEPARTMENTS) {
        planned++;
        // THE verdict. Pure, writes nothing, and it is the same call Generate
        // makes — so READY here means Generate will not refuse.
        const plan = generateRosterPlan(db, { department_id: id, week_start: weekStart });
        row.verdict = plan.ok ? 'ready' : 'blocked';
        row.refusals = plan.refusals.map((r) => ({ code: r.code, message: r.message }));
        row.warnings = plan.warnings;
        row.breaches = plan.breaches.length;
      }
      out.push(row);
    }

    return Response.json({
      week_start: weekStart,
      global: {
        departments: departments.length,
        active_departments: departments.filter((d) => d.is_active).length,
        employees_on_rolls: Number(emp.on_rolls) || 0,
        employees_without_department: Number(emp.no_department) || 0,
        employees_without_designation: Number(emp.no_designation) || 0,
        shifts_total: Number(shiftTotals.total) || 0,
        shifts_active: Number(shiftTotals.active) || 0,
        roster_rows_total: Number(rosterTotal.n) || 0,
        departments_measured: planned,
      },
      departments: out,
    });
  } catch (e) {
    console.error('GET /api/hr/roster/readiness failed:', e);
    reportServerError(e, { url: request.url });
    // GENERIC on 500 — never e.message (house rule).
    return Response.json({ error: 'Failed to measure roster readiness' }, { status: 500 });
  }
}
