/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canManageHr, isHrEmployeeStatus, isHrEmploymentType } from '@/lib/hr';
import {
  nextEmployeeCode,
  employeeListWhere,
  rowToEmployee,
  HR_EMPLOYEE_SELECT,
  HR_EMPLOYEE_JOINS,
} from '@/lib/hr-server';

/**
 * HR Employee Master (/api/hr/employees) — Phase 1.
 * Contract: docs/HRMS_DECISIONS.md (D1: employees ≠ logins; user_id nullable).
 *
 * GET  ?q=&department_id=&status=&page=&pageSize=
 *        → { rows, total, page, pageSize }
 *      Server-side pagination (default 25, cap 100). rows are every
 *      hr_employees column EXCEPT photo (has_photo 0/1 flags it — the blob is
 *      only served by the single-employee GET), plus department_name /
 *      sub_department_name / designation_name / linked_user_email (LEFT JOINs
 *      — a dangling id never hides the person). department_id matches the
 *      MAIN department OR the sub-department.
 *
 * POST { full_name (required), ...any other hr_employees field except
 *        id/employee_code/created_* } → { employee }
 *      employee_code is minted server-side (EMP-0001…) inside the same
 *      transaction as the INSERT. home_outlet_id defaults to the caller's
 *      current outlet ONLY when the body key is absent — an explicit '' is
 *      stored as ''.
 *
 * Both verbs gate on canManageHr ('@/lib/hr') — the proxy does NOT protect API
 * GETs, so this handler is the security boundary (HRMS_DECISIONS §2.1). Errors
 * return GENERIC messages only: e.message can leak schema/PII for HR data.
 */
export const dynamic = 'force-dynamic';

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** PhoneField contract (mirrors src/lib/mobile-input.ts): a value starting
 *  with '+' is a non-India E.164 number and is stored VERBATIM; only bare
 *  digits / '91'-prefixed digits are normalised to the last 10 ('' stays ''). */
function normPhone(v: unknown): string {
  const raw = String(v ?? '').trim();
  if (raw.startsWith('+')) return raw;
  return raw.replace(/\D/g, '').slice(-10);
}

/** Non-negative integer (months/days columns); garbage → 0. */
function int0(v: unknown): number {
  return Math.max(0, parseInt(String(v ?? '0'), 10) || 0);
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    const sp = new URL(request.url).searchParams;

    // parseInt (not Number) so a float like 3.7 can't reach LIMIT/OFFSET and
    // trip SQLite's "datatype mismatch" 500 (the crm-calls convention).
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(sp.get('pageSize') || '25', 10) || 25));

    // Shared WHERE builder (hr-server) — the SAME clause+params feed both the
    // page query and its COUNT(*), so total and rows can never disagree.
    const { where, params } = employeeListWhere({
      q: sp.get('q'),
      department_id: sp.get('department_id'),
      status: sp.get('status'),
    });

    const db = getDb();
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n FROM hr_employees e ${where}`)
      .get(...params) as { n: number };

    const raw = db
      .prepare(
        `${HR_EMPLOYEE_SELECT} ${HR_EMPLOYEE_JOINS} ${where}
         ORDER BY e.full_name COLLATE NOCASE, e.id
         LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as any[];

    return Response.json({
      rows: raw.map(rowToEmployee),
      total: totalRow.n,
      page,
      pageSize,
    });
  } catch (e) {
    console.error('GET /api/hr/employees failed:', e);
    return Response.json({ error: 'Failed to load employees' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* handled by field checks below */ }

  const full_name = s(body?.full_name);
  if (!full_name) {
    return Response.json({ error: 'Employee name is required' }, { status: 400 });
  }

  // Vocab gates (400, not silent coercion — a typo'd status must not create a
  // row the list filters can never find).
  const employment_type = body?.employment_type !== undefined && s(body.employment_type) !== ''
    ? s(body.employment_type)
    : 'permanent';
  if (!isHrEmploymentType(employment_type)) {
    return Response.json({ error: 'Invalid employment type' }, { status: 400 });
  }
  const status = body?.status !== undefined && s(body.status) !== '' ? s(body.status) : 'active';
  if (!isHrEmployeeStatus(status)) {
    return Response.json({ error: 'Invalid employee status' }, { status: 400 });
  }

  // Photo cap: ImageUpload compresses to ~250KB base64; anything bigger is a
  // bypassed client and would bloat the row + every detail read.
  const photo = String(body?.photo ?? '');   // base64 data URI, not trimmed content
  if (photo.length > 400_000) {
    return Response.json(
      { error: 'Photo too large - it should be a compressed image under ~300KB' },
      { status: 400 },
    );
  }

  try {
    const db = getDb();

    // Optional login link at create time. Validate up front for friendly
    // errors; the partial UNIQUE index (idx_hr_emp_user) still backstops the
    // race and is caught below. NULL (no link) is the common case — kitchen
    // helpers never get logins (contract D1).
    const user_id: string | null = s(body?.user_id) || null;
    if (user_id) {
      const userRow = db
        .prepare('SELECT id, is_active FROM users WHERE id = ?')
        .get(user_id) as any;
      if (!userRow) {
        return Response.json({ error: 'Selected login was not found' }, { status: 400 });
      }
      if (!userRow.is_active) {
        return Response.json({ error: 'That login is deactivated' }, { status: 400 });
      }
      const claimed = db
        .prepare('SELECT id FROM hr_employees WHERE user_id = ?')
        .get(user_id) as any;
      if (claimed) {
        return Response.json(
          { error: 'That login is already linked to another employee' },
          { status: 409 },
        );
      }
    }

    // Referenced-row validation at CREATE (named 400s — the backend mapping
    // rule every Phase 2-7 route follows): a non-empty reference must be a
    // real row. Empty stays allowed — these links are all optional.
    const department_id = s(body?.department_id);
    if (department_id && !db.prepare('SELECT id FROM departments WHERE id = ?').get(department_id)) {
      return Response.json({ error: 'Selected department was not found' }, { status: 400 });
    }
    const sub_department_id = s(body?.sub_department_id);
    if (sub_department_id && !db.prepare('SELECT id FROM departments WHERE id = ?').get(sub_department_id)) {
      return Response.json({ error: 'Selected sub-department was not found' }, { status: 400 });
    }
    const designation_id = s(body?.designation_id);
    if (designation_id && !db.prepare('SELECT id FROM hr_designations WHERE id = ?').get(designation_id)) {
      return Response.json({ error: 'Selected designation was not found' }, { status: 400 });
    }
    // A brand-new employee cannot equal their own manager (fresh id), so only
    // existence is checked here; the self-report guard lives on PUT.
    const reporting_manager_id = s(body?.reporting_manager_id);
    if (reporting_manager_id && !db.prepare('SELECT id FROM hr_employees WHERE id = ?').get(reporting_manager_id)) {
      return Response.json({ error: 'Selected reporting manager was not found' }, { status: 400 });
    }

    // Stamp the caller's outlet ONLY when the KEY is absent from the body —
    // an explicit '' is a deliberate "no outlet" and is stored as ''.
    // getCurrentOutletId is async — resolve it BEFORE db.transaction(); an
    // await inside the callback silently breaks better-sqlite3 atomicity.
    let home_outlet_id = s(body?.home_outlet_id);
    if (!Object.prototype.hasOwnProperty.call(body ?? {}, 'home_outlet_id')) {
      home_outlet_id = (await getCurrentOutletId()) || '';
    }

    const id = generateId();
    const record = {
      id,
      full_name,
      photo,                                     // validated (≤400K chars) above
      dob: s(body?.dob),
      gender: s(body?.gender).toLowerCase(),     // vocab keys are lowercase ('male'|'female'|'other'|'')
      phone10: normPhone(body?.phone10),
      alt_phone10: normPhone(body?.alt_phone10),
      email: s(body?.email),
      current_address: s(body?.current_address),
      permanent_address: s(body?.permanent_address),
      emergency_name: s(body?.emergency_name),
      emergency_relation: s(body?.emergency_relation),
      emergency_phone10: normPhone(body?.emergency_phone10),
      department_id,
      sub_department_id,
      designation_id,
      grade: s(body?.grade),
      reporting_manager_id,
      employment_type,
      employee_category: s(body?.employee_category),
      cost_centre: s(body?.cost_centre),
      work_location: s(body?.work_location),
      home_outlet_id,
      joining_date: s(body?.joining_date),
      probation_months: int0(body?.probation_months),
      confirmation_date: s(body?.confirmation_date),
      notice_period_days: int0(body?.notice_period_days),
      status,
      exit_date: s(body?.exit_date),
      user_id,
      notes: s(body?.notes),
      created_by: me.email,
    };

    // Code mint + INSERT + audit in ONE transaction: nextEmployeeCode reads
    // MAX(employee_code) and must not race a concurrent create (hr-server
    // contract). Everything inside is synchronous.
    const create = db.transaction(() => {
      const employee_code = nextEmployeeCode(db);
      db.prepare(
        `INSERT INTO hr_employees (
           id, employee_code, full_name, photo, dob, gender, phone10, alt_phone10,
           email, current_address, permanent_address, emergency_name,
           emergency_relation, emergency_phone10, department_id, sub_department_id,
           designation_id, grade, reporting_manager_id, employment_type,
           employee_category, cost_centre, work_location, home_outlet_id,
           joining_date, probation_months, confirmation_date, notice_period_days,
           status, exit_date, user_id, notes, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id, employee_code, record.full_name, record.photo, record.dob,
        record.gender, record.phone10, record.alt_phone10, record.email,
        record.current_address, record.permanent_address, record.emergency_name,
        record.emergency_relation, record.emergency_phone10, record.department_id,
        record.sub_department_id, record.designation_id, record.grade,
        record.reporting_manager_id, record.employment_type, record.employee_category,
        record.cost_centre, record.work_location, record.home_outlet_id,
        record.joining_date, record.probation_months, record.confirmation_date,
        record.notice_period_days, record.status, record.exit_date, record.user_id,
        record.notes, record.created_by,
      );

      // Audit the state change (house convention). Photo is excluded — a
      // ~250KB base64 blob does not belong in audit_events.
      const { photo: _photo, ...auditAfter } = record;
      logAuditEvent(db, {
        event_type: 'hr.employee.create',
        entity_type: 'hr_employee',
        entity_id: id,
        actor_email: me.email,
        outlet_id: home_outlet_id || null,
        after: { ...auditAfter, employee_code },
      });
    });

    try {
      create();
    } catch (e: any) {
      // Race on the login link: two creates claiming one users row — the
      // partial UNIQUE index idx_hr_emp_user is the authority.
      if (
        String(e?.code || '').startsWith('SQLITE_CONSTRAINT') &&
        /user_id|idx_hr_emp_user/i.test(String(e?.message || ''))
      ) {
        return Response.json(
          { error: 'That login is already linked to another employee' },
          { status: 409 },
        );
      }
      throw e;
    }

    const employee = db
      .prepare(`${HR_EMPLOYEE_SELECT} ${HR_EMPLOYEE_JOINS} WHERE e.id = ?`)
      .get(id) as any;
    return Response.json({ employee: rowToEmployee(employee) });
  } catch (e) {
    console.error('POST /api/hr/employees failed:', e);
    return Response.json({ error: 'Failed to create employee' }, { status: 500 });
  }
}
