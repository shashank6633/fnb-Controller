/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import {
  canManageHr,
  isHrCandidateStage,
  isHrEmployeeStatus,
  isHrEmploymentType,
} from '@/lib/hr';
import {
  nextEmployeeCode,
  rowToEmployee,
  HR_EMPLOYEE_SELECT,
  HR_EMPLOYEE_JOINS,
} from '@/lib/hr-server';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR Recruitment Pipeline (/api/hr/candidates) — Phase 6.
 * Contract: docs/HRMS_DECISIONS.md (§5 people lifecycle; employee_id is
 * ALWAYS hr_employees.id and is set on a candidate ONLY by convert; actor
 * columns are ALWAYS me.email).
 *
 * GET  ?q=&stage=&department_id=&page=&pageSize=
 *        → { rows, total, page, pageSize }
 *      Server-side pagination (default 25, cap 100). Rows are hr_candidates
 *      + department_name + (post-convert) employee_name / employee_code via
 *      LEFT JOINs — a dangling id degrades to null, never drops the row.
 *
 * POST { name (required), ...pipeline fields } → { candidate }
 *      Creates an 'applied' candidate. stage (when sent) must be a
 *      HR_CANDIDATE_STAGES key; 'joined' is REFUSED here — only convert may
 *      set it. department_id (when sent, non-empty) must exist.
 *
 * POST { action: 'convert', candidate_id, ...hr_employees fields }
 *        → { candidate, employee }
 *      Converts a candidate into an hr_employees row using the SAME field
 *      rules as POST /api/hr/employees (vocab gates, photo cap, phone
 *      normalisation, login-link validation, outlet stamping); body fields
 *      win, absent fields default from the candidate (name/phone/email/
 *      department/joining date). ONE transaction: mint employee_code
 *      (nextEmployeeCode — must stay inside the txn), INSERT the employee,
 *      stamp candidate.employee_id + stage 'joined' (guarded — a lost race is
 *      a 409, never a double convert), seed the onboarding checklist, audit.
 *
 * PATCH { id, ...fields } → { candidate }
 *      Stage transitions are validated against HR_CANDIDATE_STAGES; 'joined'
 *      is convert-only, and a converted candidate's stage is locked.
 *
 * DELETE ?id= → { ok }   (a converted candidate can never be deleted — its
 *      employee row references it in the audit trail).
 *
 * Every verb gates on canManageHr ('@/lib/hr') — the proxy does NOT protect
 * API GETs (HRMS_DECISIONS §2.1). Errors return GENERIC messages only.
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

/** Nullable non-negative REAL (scores / salaries): '' and garbage → null,
 *  never a coerced 0 — null means "not stated", 0 would be a statement. */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Default onboarding checklist seeded on convert (free labels per the
 *  hr_onboarding_items schema comment: kyc|bank|documents|uniform|...). */
const DEFAULT_ONBOARDING_ITEMS = [
  'kyc',
  'documents',
  'bank',
  'uniform',
  'id_card',
  'biometric',
  'training',
] as const;

/** List/detail projection: candidate + display names (LEFT JOINs — dangling
 *  department_id / employee_id degrade to null, never drop the candidate). */
const CANDIDATE_SELECT = `
  SELECT c.*,
         d.name AS department_name,
         e.full_name AS employee_name,
         e.employee_code AS employee_code
  FROM hr_candidates c
  LEFT JOIN departments d  ON d.id = c.department_id
  LEFT JOIN hr_employees e ON e.id = c.employee_id
`;

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    const sp = new URL(request.url).searchParams;
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(sp.get('pageSize') || '25', 10) || 25));

    const clauses: string[] = [];
    const params: any[] = [];
    const q = s(sp.get('q'));
    if (q) {
      const like = `%${q}%`;
      clauses.push('(c.name LIKE ? OR c.phone10 LIKE ? OR c.email LIKE ? OR c.position LIKE ?)');
      params.push(like, like, like, like);
    }
    const stage = s(sp.get('stage'));
    if (stage) {
      clauses.push('c.stage = ?');
      params.push(stage);
    }
    const dept = s(sp.get('department_id'));
    if (dept) {
      clauses.push('c.department_id = ?');
      params.push(dept);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const db = getDb();
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n FROM hr_candidates c ${where}`)
      .get(...params) as { n: number };
    const rows = db
      .prepare(`${CANDIDATE_SELECT} ${where} ORDER BY c.created_at DESC, c.id LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as any[];

    return Response.json({ rows, total: totalRow.n, page, pageSize });
  } catch (e) {
    console.error('[hr-candidates] GET failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load candidates' }, { status: 500 });
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

  if (s(body?.action) === 'convert') return convertCandidate(request, me, body);

  const name = s(body?.name);
  if (!name) {
    return Response.json({ error: 'Candidate name is required' }, { status: 400 });
  }

  // Stage vocab gate (400, not silent coercion). 'joined' is reserved for
  // convert — a hand-set 'joined' with no employee row would be a lie the
  // pipeline board can never reconcile.
  const stage = body?.stage !== undefined && s(body.stage) !== '' ? s(body.stage) : 'applied';
  if (!isHrCandidateStage(stage)) {
    return Response.json({ error: 'Invalid candidate stage' }, { status: 400 });
  }
  if (stage === 'joined') {
    return Response.json(
      { error: 'Use convert to mark a candidate as joined' },
      { status: 400 },
    );
  }

  try {
    const db = getDb();

    // Referenced-row validation on CREATE (backend mapping rule): a non-empty
    // department_id must be a real departments.id.
    const department_id = s(body?.department_id);
    if (department_id) {
      const dept = db.prepare('SELECT id FROM departments WHERE id = ?').get(department_id);
      if (!dept) {
        return Response.json({ error: 'Selected department was not found' }, { status: 400 });
      }
    }

    const id = generateId();
    const record = {
      id,
      name,
      phone10: normPhone(body?.phone10),
      email: s(body?.email),
      position: s(body?.position),
      department_id,
      resume_note: s(body?.resume_note),
      interview_score: numOrNull(body?.interview_score),
      expected_salary: numOrNull(body?.expected_salary),
      offered_salary: numOrNull(body?.offered_salary),
      joining_date: s(body?.joining_date),
      stage,
      note: s(body?.note),
      created_by: me.email,
    };

    const create = db.transaction(() => {
      db.prepare(
        `INSERT INTO hr_candidates (
           id, name, phone10, email, position, department_id, resume_note,
           interview_score, expected_salary, offered_salary, joining_date,
           stage, employee_id, note, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
      ).run(
        record.id, record.name, record.phone10, record.email, record.position,
        record.department_id, record.resume_note, record.interview_score,
        record.expected_salary, record.offered_salary, record.joining_date,
        record.stage, record.note, record.created_by,
      );
      logAuditEvent(db, {
        event_type: 'hr.candidate.create',
        entity_type: 'hr_candidate',
        entity_id: id,
        actor_email: me.email,
        after: record,
      });
    });
    create();

    const candidate = db.prepare(`${CANDIDATE_SELECT} WHERE c.id = ?`).get(id) as any;
    return Response.json({ candidate });
  } catch (e) {
    console.error('[hr-candidates] POST failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to create candidate' }, { status: 500 });
  }
}

/**
 * POST {action:'convert'} — candidate → hr_employees row, ONE transaction.
 * Field rules are IDENTICAL to POST /api/hr/employees; absent body fields
 * default from the candidate so a one-click convert still lands a complete
 * employee row.
 */
async function convertCandidate(
  request: Request,
  me: { email: string },
  body: any,
): Promise<Response> {
  const candidate_id = s(body?.candidate_id);
  if (!candidate_id) {
    return Response.json({ error: 'candidate_id is required' }, { status: 400 });
  }

  try {
    const db = getDb();
    const cand = db
      .prepare('SELECT * FROM hr_candidates WHERE id = ?')
      .get(candidate_id) as any;
    if (!cand) {
      return Response.json({ error: 'Candidate was not found' }, { status: 404 });
    }
    if (s(cand.employee_id)) {
      return Response.json(
        { error: 'This candidate has already been converted to an employee' },
        { status: 409 },
      );
    }
    if (cand.stage === 'rejected') {
      return Response.json(
        { error: 'A rejected candidate cannot be converted' },
        { status: 400 },
      );
    }

    const has = (k: string) => Object.prototype.hasOwnProperty.call(body ?? {}, k);

    // ---- SAME field rules as POST /api/hr/employees (exemplar route) ----
    const full_name = has('full_name') ? s(body.full_name) : s(cand.name);
    if (!full_name) {
      return Response.json({ error: 'Employee name is required' }, { status: 400 });
    }

    const employment_type =
      body?.employment_type !== undefined && s(body.employment_type) !== ''
        ? s(body.employment_type)
        : 'permanent';
    if (!isHrEmploymentType(employment_type)) {
      return Response.json({ error: 'Invalid employment type' }, { status: 400 });
    }
    const status = body?.status !== undefined && s(body.status) !== '' ? s(body.status) : 'active';
    if (!isHrEmployeeStatus(status)) {
      return Response.json({ error: 'Invalid employee status' }, { status: 400 });
    }

    const photo = String(body?.photo ?? '');
    if (photo.length > 400_000) {
      return Response.json(
        { error: 'Photo too large - it should be a compressed image under ~300KB' },
        { status: 400 },
      );
    }

    // Optional login link — validated up front for friendly errors; the
    // partial UNIQUE index idx_hr_emp_user still backstops the race below.
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

    // Referenced-row validation at CREATE (named 400s — same rule as
    // POST /api/hr/employees): a non-empty reference must be a real row.
    // Validated on the RESOLVED value (body wins, candidate default fills in)
    // so a dangling candidate department cannot slip through either.
    const department_id = has('department_id') ? s(body.department_id) : s(cand.department_id);
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
    // The new employee's id is freshly minted, so self-report is impossible
    // here — existence is the only check needed.
    const reporting_manager_id = s(body?.reporting_manager_id);
    if (reporting_manager_id && !db.prepare('SELECT id FROM hr_employees WHERE id = ?').get(reporting_manager_id)) {
      return Response.json({ error: 'Selected reporting manager was not found' }, { status: 400 });
    }

    // Outlet stamped ONLY when the key is absent (explicit '' is deliberate).
    // getCurrentOutletId is async — resolved BEFORE db.transaction().
    let home_outlet_id = s(body?.home_outlet_id);
    if (!has('home_outlet_id')) {
      home_outlet_id = (await getCurrentOutletId()) || '';
    }

    const id = generateId();
    const record = {
      id,
      full_name,
      photo,
      dob: s(body?.dob),
      gender: s(body?.gender).toLowerCase(),
      phone10: has('phone10') ? normPhone(body.phone10) : s(cand.phone10),
      alt_phone10: normPhone(body?.alt_phone10),
      email: has('email') ? s(body.email) : s(cand.email),
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
      joining_date: has('joining_date') ? s(body.joining_date) : s(cand.joining_date),
      probation_months: int0(body?.probation_months),
      confirmation_date: s(body?.confirmation_date),
      notice_period_days: int0(body?.notice_period_days),
      status,
      exit_date: s(body?.exit_date),
      user_id,
      notes: s(body?.notes),
      created_by: me.email,
    };

    // ONE transaction: guarded candidate claim + code mint + employee INSERT
    // + onboarding seed + audit. The guarded UPDATE (employee_id still '')
    // makes a lost convert race a rollback + 409, never two employees.
    let minted_code = '';
    const convert = db.transaction(() => {
      const claim = db
        .prepare(
          `UPDATE hr_candidates
           SET employee_id = ?, stage = 'joined', updated_at = datetime('now')
           WHERE id = ? AND (employee_id = '' OR employee_id IS NULL)`,
        )
        .run(id, candidate_id);
      if (claim.changes === 0) {
        throw Object.assign(new Error('candidate already converted'), {
          hrCode: 'ALREADY_CONVERTED',
        });
      }

      const employee_code = nextEmployeeCode(db);
      minted_code = employee_code;
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

      const seed = db.prepare(
        `INSERT INTO hr_onboarding_items (id, employee_id, item, sort_order)
         VALUES (?, ?, ?, ?)`,
      );
      DEFAULT_ONBOARDING_ITEMS.forEach((item, i) => {
        seed.run(generateId(), id, item, i);
      });

      // Photo excluded from audit (a ~250KB blob does not belong there).
      const { photo: _photo, ...auditAfter } = record;
      logAuditEvent(db, {
        event_type: 'hr.employee.create',
        entity_type: 'hr_employee',
        entity_id: id,
        actor_email: me.email,
        outlet_id: home_outlet_id || null,
        after: { ...auditAfter, employee_code },
      });
      logAuditEvent(db, {
        event_type: 'hr.candidate.convert',
        entity_type: 'hr_candidate',
        entity_id: candidate_id,
        actor_email: me.email,
        before: { stage: cand.stage, employee_id: '' },
        after: { stage: 'joined', employee_id: id, employee_code },
      });
    });

    try {
      convert();
    } catch (e: any) {
      if (e?.hrCode === 'ALREADY_CONVERTED') {
        return Response.json(
          { error: 'This candidate has already been converted to an employee' },
          { status: 409 },
        );
      }
      // Race on the login link — the partial UNIQUE index is the authority.
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
    const candidate = db.prepare(`${CANDIDATE_SELECT} WHERE c.id = ?`).get(candidate_id) as any;
    return Response.json({ candidate, employee: rowToEmployee(employee), employee_code: minted_code });
  } catch (e) {
    console.error('[hr-candidates] convert failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to convert candidate' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }

  const id = s(body?.id);
  if (!id) return Response.json({ error: 'Candidate id is required' }, { status: 400 });

  try {
    const db = getDb();
    const cand = db.prepare('SELECT * FROM hr_candidates WHERE id = ?').get(id) as any;
    if (!cand) return Response.json({ error: 'Candidate was not found' }, { status: 404 });

    const has = (k: string) => Object.prototype.hasOwnProperty.call(body ?? {}, k);
    const sets: string[] = [];
    const vals: any[] = [];

    if (has('name')) {
      const name = s(body.name);
      if (!name) return Response.json({ error: 'Candidate name is required' }, { status: 400 });
      sets.push('name = ?');
      vals.push(name);
    }
    if (has('phone10')) { sets.push('phone10 = ?'); vals.push(normPhone(body.phone10)); }
    if (has('email')) { sets.push('email = ?'); vals.push(s(body.email)); }
    if (has('position')) { sets.push('position = ?'); vals.push(s(body.position)); }
    if (has('resume_note')) { sets.push('resume_note = ?'); vals.push(s(body.resume_note)); }
    if (has('note')) { sets.push('note = ?'); vals.push(s(body.note)); }
    if (has('joining_date')) { sets.push('joining_date = ?'); vals.push(s(body.joining_date)); }
    if (has('interview_score')) { sets.push('interview_score = ?'); vals.push(numOrNull(body.interview_score)); }
    if (has('expected_salary')) { sets.push('expected_salary = ?'); vals.push(numOrNull(body.expected_salary)); }
    if (has('offered_salary')) { sets.push('offered_salary = ?'); vals.push(numOrNull(body.offered_salary)); }

    if (has('department_id')) {
      const department_id = s(body.department_id);
      if (department_id) {
        const dept = db.prepare('SELECT id FROM departments WHERE id = ?').get(department_id);
        if (!dept) {
          return Response.json({ error: 'Selected department was not found' }, { status: 400 });
        }
      }
      sets.push('department_id = ?');
      vals.push(department_id);
    }

    if (has('stage')) {
      const stage = s(body.stage);
      if (!isHrCandidateStage(stage)) {
        return Response.json({ error: 'Invalid candidate stage' }, { status: 400 });
      }
      if (stage !== cand.stage) {
        if (s(cand.employee_id)) {
          return Response.json(
            { error: 'This candidate has already joined - the stage is locked' },
            { status: 400 },
          );
        }
        if (stage === 'joined') {
          return Response.json(
            { error: 'Use convert to mark a candidate as joined' },
            { status: 400 },
          );
        }
        sets.push('stage = ?');
        vals.push(stage);
      }
    }

    if (sets.length === 0) {
      return Response.json({ error: 'Nothing to update' }, { status: 400 });
    }

    const update = db.transaction(() => {
      db.prepare(
        `UPDATE hr_candidates SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      ).run(...vals, id);
      const after = db.prepare('SELECT * FROM hr_candidates WHERE id = ?').get(id);
      logAuditEvent(db, {
        event_type: 'hr.candidate.update',
        entity_type: 'hr_candidate',
        entity_id: id,
        actor_email: me.email,
        before: cand,
        after,
      });
    });
    update();

    const candidate = db.prepare(`${CANDIDATE_SELECT} WHERE c.id = ?`).get(id) as any;
    return Response.json({ candidate });
  } catch (e) {
    console.error('[hr-candidates] PATCH failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update candidate' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    const id = s(new URL(request.url).searchParams.get('id'));
    if (!id) return Response.json({ error: 'Candidate id is required' }, { status: 400 });

    const db = getDb();
    const cand = db.prepare('SELECT * FROM hr_candidates WHERE id = ?').get(id) as any;
    if (!cand) return Response.json({ error: 'Candidate was not found' }, { status: 404 });
    if (s(cand.employee_id)) {
      return Response.json(
        { error: 'A converted candidate cannot be deleted' },
        { status: 409 },
      );
    }

    const remove = db.transaction(() => {
      db.prepare('DELETE FROM hr_candidates WHERE id = ?').run(id);
      logAuditEvent(db, {
        event_type: 'hr.candidate.delete',
        entity_type: 'hr_candidate',
        entity_id: id,
        actor_email: me.email,
        before: cand,
      });
    });
    remove();

    return Response.json({ ok: true });
  } catch (e) {
    console.error('[hr-candidates] DELETE failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to delete candidate' }, { status: 500 });
  }
}
