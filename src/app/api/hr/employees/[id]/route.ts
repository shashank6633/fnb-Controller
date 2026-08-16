/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canManageHr, isHrEmployeeStatus, isHrEmploymentType } from '@/lib/hr';
import {
  HR_EMPLOYEE_SELECT_FULL,
  HR_EMPLOYEE_JOINS,
  rowToEmployee,
  employeeOutletIds,
  replaceEmployeeOutlets,
} from '@/lib/hr-server';

/**
 * Single employee (/api/hr/employees/:id) — HRMS Phase 1.
 * Contract: docs/HRMS_DECISIONS.md (D1: HR never writes the users table).
 *
 * GET    → { employee }  (joined department/sub-department/designation names,
 *          linked_user_email + linked_user_name, outlets: string[] from
 *          hr_employee_outlets).
 * PUT    → partial edit over an explicit column allowlist (never spread the
 *          body into SQL). Also the ONLY place a login is linked/unlinked:
 *          `user_id: null` unlinks; a users.id links (target must exist and be
 *          active; the idx_hr_emp_user UNIQUE violation → 409). An `outlets`
 *          array fully replaces hr_employee_outlets — same transaction as the
 *          field update. Rebuilds updated_at. NOTE: `status` is deliberately
 *          NOT in the PUT allowlist — status changes go through PATCH so the
 *          deactivation suggestion + status audit can never be bypassed.
 * PATCH  → { action: 'set_status', status, note } (note REQUIRED — 400 when it
 *          trims empty). Descriptive ONLY — never
 *          touches users.is_active (deactivating a login is an explicit admin
 *          action on /users). When the new status is resigned/terminated/former
 *          and a login is linked, the response carries
 *          suggest_deactivate_login: true so the UI can point the admin there.
 *
 * All three gates: canManageHr (the proxy does NOT protect API GETs — this
 * handler is the security boundary). Errors are GENERIC on the wire (HR data;
 * e.message can leak schema) — details go to the server log only.
 * CSRF on mutations enforced by proxy.ts ('/api/hr' prefix) via api()/apiJson().
 */
export const dynamic = 'force-dynamic';

/** hr_employees columns PUT may set directly (TEXT). id / employee_code /
 *  created_* are never writable; status goes via PATCH; user_id + outlets are
 *  handled specially below. */
const TEXT_FIELDS = [
  'full_name',
  'photo',
  'dob',
  'gender',
  'phone10',
  'alt_phone10',
  'email',
  'current_address',
  'permanent_address',
  'emergency_name',
  'emergency_relation',
  'emergency_phone10',
  'department_id',
  'sub_department_id',
  'designation_id',
  'grade',
  'reporting_manager_id',
  'employment_type',
  'employee_category',
  'cost_centre',
  'work_location',
  'home_outlet_id',
  'joining_date',
  'confirmation_date',
  'exit_date',
  'notes',
] as const;

/** INTEGER columns PUT may set (coerced, never negative). */
const INT_FIELDS = ['probation_months', 'notice_period_days'] as const;

/** PhoneField contract (mirrors src/lib/mobile-input.ts): a value starting
 *  with '+' is non-India E.164 and is stored VERBATIM; bare digits or a
 *  91-prefixed entry are normalised to the LAST 10 digits. */
const PHONE_FIELDS = new Set(['phone10', 'alt_phone10', 'emergency_phone10']);

/** Exit states that should prompt the admin to deactivate a linked login. */
const EXIT_STATUSES = new Set(['resigned', 'terminated', 'former']);

const has = (o: any, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Full detail shape of the contract: joined names + linked user + outlets. */
function loadEmployee(db: any, id: string) {
  const row = db
    .prepare(
      `${HR_EMPLOYEE_SELECT_FULL}, u.name AS linked_user_name ${HR_EMPLOYEE_JOINS} WHERE e.id = ?`,
    )
    .get(id) as any;
  if (!row) return null;
  return { ...rowToEmployee(row), outlets: employeeOutletIds(db, id) };
}

/** Audit snapshot: the raw table row minus the base64 photo blob (audit_events
 *  has no retention — a ~250KB image per edit would bloat it for nothing). */
function auditSnapshot(row: any, outlets?: string[]) {
  if (!row) return null;
  const { photo, ...rest } = row;
  const snap: any = { ...rest, photo: photo ? '[image]' : '' };
  if (outlets !== undefined) snap.outlets = outlets;
  return snap;
}

async function requireHrManager(): Promise<{ me: any } | { resp: Response }> {
  const me = await getCurrentUser();
  if (!me) return { resp: Response.json({ error: 'Sign in required' }, { status: 401 }) };
  if (!canManageHr(me)) {
    return { resp: Response.json({ error: 'Management access required' }, { status: 403 }) };
  }
  return { me };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireHrManager();
  if ('resp' in g) return g.resp;
  try {
    const { id } = await params;
    const employee = loadEmployee(getDb(), id);
    if (!employee) return Response.json({ error: 'Employee not found' }, { status: 404 });
    return Response.json({ employee });
  } catch (e) {
    console.error('GET /api/hr/employees/[id] failed:', e);
    return Response.json({ error: 'Failed to load employee' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireHrManager();
  if ('resp' in g) return g.resp;
  const { me } = g;

  try {
    // Resolve EVERY await before the transaction — better-sqlite3 is
    // synchronous and an await inside db.transaction() silently breaks
    // atomicity.
    const { id } = await params;
    let body: any = {};
    try { body = await request.json(); } catch { /* handled below */ }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const actorOutletId = await getCurrentOutletId();

    const db = getDb();
    const existing = db.prepare('SELECT * FROM hr_employees WHERE id = ?').get(id) as any;
    if (!existing) return Response.json({ error: 'Employee not found' }, { status: 404 });

    const sets: string[] = [];
    const args: any[] = [];

    for (const f of TEXT_FIELDS) {
      if (!has(body, f)) continue;
      let v = String(body[f] ?? '').trim();
      if (f === 'full_name' && !v) {
        return Response.json({ error: 'Name is required' }, { status: 400 });
      }
      if (f === 'employment_type') {
        if (!v) v = 'permanent';
        else if (!isHrEmploymentType(v)) {
          return Response.json({ error: 'Invalid employment type' }, { status: 400 });
        }
      }
      if (f === 'photo' && v.length > 400_000) {
        return Response.json(
          { error: 'Photo too large - it should be a compressed image under ~300KB' },
          { status: 400 },
        );
      }
      if (f === 'gender') v = v.toLowerCase();
      if (f === 'reporting_manager_id' && v && v === id) {
        return Response.json({ error: 'An employee cannot report to themselves' }, { status: 400 });
      }
      // '+'-prefixed = non-India E.164, stored verbatim; otherwise norm to last-10.
      if (PHONE_FIELDS.has(f) && v && !v.startsWith('+')) {
        v = v.replace(/\D+/g, '').slice(-10);
      }
      sets.push(`${f} = ?`);
      args.push(v);
    }

    for (const f of INT_FIELDS) {
      if (!has(body, f)) continue;
      const raw = Number(body[f]);
      const n = Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
      sets.push(`${f} = ?`);
      args.push(n);
    }

    // ---- user_id link / unlink (D1: validate here, never write users) ----
    if (has(body, 'user_id')) {
      const raw = body.user_id;
      if (raw === null || String(raw).trim() === '') {
        sets.push('user_id = NULL');
      } else {
        const userId = String(raw).trim();
        const target = db
          .prepare('SELECT id, is_active FROM users WHERE id = ?')
          .get(userId) as any;
        if (!target) {
          return Response.json({ error: 'That login was not found' }, { status: 400 });
        }
        if (!target.is_active) {
          return Response.json({ error: 'That login is deactivated' }, { status: 400 });
        }
        const claimed = db
          .prepare('SELECT id FROM hr_employees WHERE user_id = ? AND id != ?')
          .get(userId, id) as any;
        if (claimed) {
          return Response.json(
            { error: 'That login is already linked to another employee' },
            { status: 409 },
          );
        }
        sets.push('user_id = ?');
        args.push(userId);
      }
    }

    // ---- outlets replacement (same transaction as the field update) ----
    const outletsProvided = has(body, 'outlets');
    if (outletsProvided && !Array.isArray(body.outlets)) {
      return Response.json({ error: 'outlets must be an array of outlet ids' }, { status: 400 });
    }
    const outletList: string[] = outletsProvided
      ? (body.outlets as unknown[]).map((o) => String(o ?? '').trim()).filter(Boolean)
      : [];

    if (!sets.length && !outletsProvided) {
      return Response.json({ error: 'Nothing to update' }, { status: 400 });
    }

    const beforeOutlets = outletsProvided ? employeeOutletIds(db, id) : undefined;

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE hr_employees SET ${sets.length ? `${sets.join(', ')}, ` : ''}updated_at = datetime('now') WHERE id = ?`,
      ).run(...args, id);
      if (outletsProvided) replaceEmployeeOutlets(db, id, outletList, generateId);
    });
    try {
      tx();
    } catch (e: any) {
      // Race with a concurrent link: the partial UNIQUE index is the referee.
      if (
        e?.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
        /idx_hr_emp_user|user_id/.test(String(e?.message || ''))
      ) {
        return Response.json(
          { error: 'That login is already linked to another employee' },
          { status: 409 },
        );
      }
      throw e;
    }

    const afterRow = db.prepare('SELECT * FROM hr_employees WHERE id = ?').get(id) as any;
    logAuditEvent(db, {
      event_type: 'hr.employee.update',
      entity_type: 'hr_employee',
      entity_id: id,
      actor_email: me.email,
      outlet_id: actorOutletId,
      before: auditSnapshot(existing, beforeOutlets),
      after: auditSnapshot(afterRow, outletsProvided ? employeeOutletIds(db, id) : undefined),
    });

    return Response.json({ employee: loadEmployee(db, id) });
  } catch (e) {
    console.error('PUT /api/hr/employees/[id] failed:', e);
    return Response.json({ error: 'Failed to update employee' }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireHrManager();
  if ('resp' in g) return g.resp;
  const { me } = g;

  try {
    const { id } = await params;
    let body: any = {};
    try { body = await request.json(); } catch { /* handled below */ }
    const action = String(body?.action || '').trim();
    if (action !== 'set_status') {
      return Response.json({ error: 'Unknown action' }, { status: 400 });
    }
    const status = String(body?.status || '').trim();
    if (!isHrEmployeeStatus(status)) {
      return Response.json({ error: 'Invalid status' }, { status: 400 });
    }
    const note = String(body?.note ?? '').trim();
    if (!note) {
      return Response.json(
        { error: 'A note explaining the change is required' },
        { status: 400 },
      );
    }
    const actorOutletId = await getCurrentOutletId();

    const db = getDb();
    const existing = db.prepare('SELECT * FROM hr_employees WHERE id = ?').get(id) as any;
    if (!existing) return Response.json({ error: 'Employee not found' }, { status: 404 });

    db.prepare(
      "UPDATE hr_employees SET status = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(status, id);

    logAuditEvent(db, {
      event_type: 'hr.employee.status',
      entity_type: 'hr_employee',
      entity_id: id,
      actor_email: me.email,
      outlet_id: actorOutletId,
      before: { status: existing.status },
      after: { status },
      note,
    });

    // Contract D1: HR NEVER writes users.is_active. When an exit status lands
    // on an employee with a linked login, the UI points the owner at /users to
    // deactivate it as an explicit admin action.
    const suggest_deactivate_login = EXIT_STATUSES.has(status) && !!existing.user_id;

    return Response.json({ employee: loadEmployee(db, id), suggest_deactivate_login });
  } catch (e) {
    console.error('PATCH /api/hr/employees/[id] failed:', e);
    return Response.json({ error: 'Failed to update employee status' }, { status: 500 });
  }
}
