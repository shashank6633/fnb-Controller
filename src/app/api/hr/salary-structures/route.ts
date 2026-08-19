/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canAdminHr } from '@/lib/hr';
import type { HrSalaryStructure } from '@/lib/hr';
import { reportServerError } from '@/lib/error-alerts';

/**
 * Salary structures (/api/hr/salary-structures) — HRMS Phase 4.
 * Contract: docs/HRMS_DECISIONS.md §5 (hr_salary_structures: effective_from/to,
 * NEVER overwritten) + the Phases 3-7 backend-mapping rules in db.ts.
 *
 * THIS IS MONEY. Every verb (GET included) gates on canAdminHr — the proxy
 * does NOT protect API GETs (HRMS_DECISIONS §2.1), so this handler is the
 * security boundary. canManageHr (managers/HODs) is deliberately NOT enough.
 *
 * GET  ?employee_id=<hr_employees.id>
 *        → { rows }
 *      The FULL revision history for one employee, ordered effective_from
 *      DESC (current structure first — the row with effective_to = '').
 *      Deliberately UNPAGINATED: a person's salary history is a short
 *      timeline and the page renders all of it. Rows carry employee_code /
 *      employee_name via LEFT JOIN hr_employees (a dangling employee_id
 *      degrades to null names, never a dropped row).
 *
 * POST { employee_id, effective_from, basic, hra, allowances_json,
 *        deductions_json, note }
 *        → { structure }
 *      A salary REVISION — the append-only money-history write:
 *       · employee_id must reference an existing hr_employees row (400 with
 *         a named message otherwise — the create-side FK rule).
 *       · gross/net are computed SERVER-SIDE (gross = basic + hra +
 *         Σ allowances; net = gross − Σ deductions) — client-sent gross/net
 *         are ignored.
 *       · effective_from must be strictly AFTER the latest existing
 *         structure's effective_from — equal or earlier → 409. History is
 *         forward-dated, full stop.
 *       · In the SAME transaction: the previous OPEN row (effective_to = '')
 *         is closed to the day before the new effective_from, and the new
 *         open-ended row is inserted. Closing effective_to is the ONLY write
 *         old rows ever receive; amounts on old rows are immutable.
 *       · allowances_json / deductions_json accept a [{label, amount}] array
 *         (or its JSON string); amounts must be finite and ≥ 0.
 *      Audited as hr.salary.revise (before = the closed prior row, after =
 *      the new row).
 *
 * Errors are GENERIC on the wire (never e.message — salary data): named 400s
 * above are static strings, everything else is the catch-all 500.
 */
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** True for a real calendar date in YYYY-MM-DD (rejects 2026-02-30). */
function isYmd(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** The calendar day before a YYYY-MM-DD (pure date math, timezone-free). */
function dayBefore(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

/** Round money to 2dp (kills float dust from the Σ below). */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Finite non-negative money number from body input; null = invalid. */
function money(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return r2(n);
}

/**
 * Normalise an allowances/deductions payload to [{label, amount}].
 * Accepts an array or its JSON string ('' / null / undefined = []).
 * Returns null when the shape is invalid (empty label, negative or
 * non-finite amount, non-array JSON).
 */
function parseLines(v: unknown): { label: string; amount: number }[] | null {
  let arr: unknown = v;
  if (typeof v === 'string') {
    if (v.trim() === '') return [];
    try { arr = JSON.parse(v); } catch { return null; }
  }
  if (arr === undefined || arr === null) return [];
  if (!Array.isArray(arr)) return null;
  const out: { label: string; amount: number }[] = [];
  for (const item of arr) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const label = s((item as any).label);
    const amount = Number((item as any).amount);
    if (!label) return null;
    if (!Number.isFinite(amount) || amount < 0) return null;
    out.push({ label, amount: r2(amount) });
  }
  return out;
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  try {
    const sp = new URL(request.url).searchParams;
    const employee_id = s(sp.get('employee_id'));
    if (!employee_id) {
      return Response.json({ error: 'Employee is required' }, { status: 400 });
    }

    const db = getDb();
    const rows = db
      .prepare(
        `SELECT s.*, e.employee_code, e.full_name AS employee_name
         FROM hr_salary_structures s
         LEFT JOIN hr_employees e ON e.id = s.employee_id
         WHERE s.employee_id = ?
         ORDER BY s.effective_from DESC, s.created_at DESC`,
      )
      .all(employee_id);

    return Response.json({ rows });
  } catch (e) {
    console.error('[hr-salary-structures]', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load salary history' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled by field checks below */ }

  const employee_id = s(body?.employee_id);
  if (!employee_id) {
    return Response.json({ error: 'Employee is required' }, { status: 400 });
  }

  const effective_from = s(body?.effective_from);
  if (!isYmd(effective_from)) {
    return Response.json({ error: 'A valid effective date (YYYY-MM-DD) is required' }, { status: 400 });
  }

  const basic = money(body?.basic);
  if (basic === null) {
    return Response.json({ error: 'Basic must be a non-negative amount' }, { status: 400 });
  }
  const hra = money(body?.hra);
  if (hra === null) {
    return Response.json({ error: 'HRA must be a non-negative amount' }, { status: 400 });
  }

  const allowances = parseLines(body?.allowances_json);
  if (allowances === null) {
    return Response.json(
      { error: 'Allowances must be a list of { label, amount } lines with non-negative amounts' },
      { status: 400 },
    );
  }
  const deductions = parseLines(body?.deductions_json);
  if (deductions === null) {
    return Response.json(
      { error: 'Deductions must be a list of { label, amount } lines with non-negative amounts' },
      { status: 400 },
    );
  }

  // Server-side money math — client-sent gross/net are ignored.
  const gross = r2(basic + hra + allowances.reduce((sum, a) => sum + a.amount, 0));
  const totalDeductions = r2(deductions.reduce((sum, d) => sum + d.amount, 0));
  const net = r2(gross - totalDeductions);
  if (net < 0) {
    return Response.json({ error: 'Deductions cannot exceed gross salary' }, { status: 400 });
  }

  try {
    const db = getDb();

    // Create-side reference rule: the employee row must exist (reads stay
    // LEFT-JOIN tolerant; writes do not).
    const employee = db
      .prepare('SELECT id, employee_code, full_name, home_outlet_id FROM hr_employees WHERE id = ?')
      .get(employee_id) as any;
    if (!employee) {
      return Response.json({ error: 'Selected employee was not found' }, { status: 400 });
    }

    // The latest existing structure (by effective_from) is the revision
    // baseline. Forward-dating is absolute: a new row starting on or before
    // it would fork the money timeline → 409.
    const prior = db
      .prepare(
        `SELECT * FROM hr_salary_structures
         WHERE employee_id = ?
         ORDER BY effective_from DESC, created_at DESC
         LIMIT 1`,
      )
      .get(employee_id) as HrSalaryStructure | undefined;

    if (prior && effective_from <= prior.effective_from) {
      return Response.json(
        {
          error: `A structure effective ${prior.effective_from} already exists — the revision must start after it`,
        },
        { status: 409 },
      );
    }

    const id = generateId();
    const record = {
      id,
      employee_id,
      effective_from,
      effective_to: '',                      // the new row is the open, current structure
      basic,
      hra,
      allowances_json: JSON.stringify(allowances),
      gross,
      deductions_json: JSON.stringify(deductions),
      net,
      note: s(body?.note),
      created_by: me.email,                  // actor = me.email, NEVER an employee id
    };

    // Close-prior + insert + audit in ONE transaction (everything inside is
    // synchronous; all awaits are resolved above). Closing effective_to is
    // the only UPDATE an old money row ever receives; if the prior row was
    // already closed by hand, it is left untouched.
    const revise = db.transaction(() => {
      if (prior && prior.effective_to === '') {
        db.prepare('UPDATE hr_salary_structures SET effective_to = ? WHERE id = ?')
          .run(dayBefore(effective_from), prior.id);
      }
      db.prepare(
        `INSERT INTO hr_salary_structures (
           id, employee_id, effective_from, effective_to, basic, hra,
           allowances_json, gross, deductions_json, net, note, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id, record.employee_id, record.effective_from, record.effective_to,
        record.basic, record.hra, record.allowances_json, record.gross,
        record.deductions_json, record.net, record.note, record.created_by,
      );
      logAuditEvent(db, {
        event_type: 'hr.salary.revise',
        entity_type: 'hr_salary_structure',
        entity_id: id,
        actor_email: me.email,
        outlet_id: employee.home_outlet_id || null,
        before: prior,
        after: record,
      });
    });
    revise();

    const structure = db
      .prepare(
        `SELECT s.*, e.employee_code, e.full_name AS employee_name
         FROM hr_salary_structures s
         LEFT JOIN hr_employees e ON e.id = s.employee_id
         WHERE s.id = ?`,
      )
      .get(id);
    return Response.json({ structure });
  } catch (e) {
    console.error('[hr-salary-structures]', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to save the salary revision' }, { status: 500 });
  }
}
