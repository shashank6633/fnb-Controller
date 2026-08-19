/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canAdminHr, canManageHr, maskAccountNumber, type HrBankAccount } from '@/lib/hr';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR Bank Accounts (/api/hr/bank) — Phase 4.
 * Contract: docs/HRMS_DECISIONS.md (§2 — bank details are an adminOnly
 * surface; hr_bank_accounts comment in db.ts: full account number readable
 * ONLY by admin callers, every other surface gets the mask).
 *
 * GET    ?employee_id=&include_inactive=1&page=&pageSize=
 *          → { rows, total, page, pageSize, can_view_full }
 *        Management tier may LIST (the employee profile shows bank state),
 *        but account_number is masked server-side via maskAccountNumber
 *        unless the caller is canAdminHr — the full number NEVER rides the
 *        wire to a non-admin, so no client can "unmask" it. Rows LEFT JOIN
 *        hr_employees for employee_name/employee_code (dangling employee_id
 *        degrades to blank, never drops the row).
 * POST   { employee_id, account_number, ifsc, bank_name?, account_holder?,
 *          branch?, account_type? } → { account }
 *        Admin only. employee_id must exist (400), account_number non-empty
 *        (spaces stripped), IFSC must match the RBI shape
 *        (4 letters + '0' + 6 alphanumerics, case-insensitive; stored
 *        uppercase). Duplicate active account number for the same employee
 *        → 409. New rows start verify_status='unverified'.
 * PUT    { id, ...fields } → { account }
 *        Admin only. Same field validation as POST. Changing account_number
 *        or ifsc RESETS verification (verify_status='unverified',
 *        verified_by/verified_at cleared) — a verified flag must never
 *        survive a number edit. employee_id is NOT updatable: a bank row
 *        belongs to one person forever; add a new row instead.
 * PATCH  { id, action: 'verify' | 'reject' } → { account }
 *        Admin only. Sets verify_status ('verified'|'rejected'),
 *        verified_by = me.email, verified_at = now.
 *
 * Audit: hr.bank.create / hr.bank.update / hr.bank.verify / hr.bank.reject —
 * before/after payloads carry the MASKED account number only (last-4), never
 * the full value; audit_events is a wider-read surface than this route.
 * Errors are GENERIC (never e.message — bank data must not leak through
 * error bodies).
 */
export const dynamic = 'force-dynamic';

/** RBI IFSC shape: 4 letters + '0' + 6 alphanumerics (case-insensitive). */
const IFSC_RE = /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/;

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** Account number with ALL whitespace stripped (matches maskAccountNumber). */
function normAccount(v: unknown): string {
  return String(v ?? '').replace(/\s+/g, '');
}

/** Row + joined employee display fields, as GET returns them. */
type BankRow = HrBankAccount & {
  employee_name?: string | null;
  employee_code?: string | null;
};

/** Wire shape: the full account number leaves the server ONLY when full=true
 *  (canAdminHr). Masking happens HERE, server-side — never on the client. */
function serialize(row: BankRow, full: boolean): BankRow {
  return {
    ...row,
    account_number: full
      ? String(row.account_number ?? '')
      : maskAccountNumber(row.account_number),
  };
}

/** Audit payload: ALWAYS masked (last-4 only), whoever the actor is. */
function auditShape(row: BankRow | Record<string, unknown>): Record<string, unknown> {
  const r = row as Record<string, unknown>;
  return { ...r, account_number: maskAccountNumber(String(r.account_number ?? '')) };
}

const SELECT_ONE = `
  SELECT b.*, e.full_name AS employee_name, e.employee_code
    FROM hr_bank_accounts b
    LEFT JOIN hr_employees e ON e.id = b.employee_id
   WHERE b.id = ?`;

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    const sp = new URL(request.url).searchParams;

    // parseInt (not Number) so a float can't reach LIMIT/OFFSET and trip
    // SQLite's "datatype mismatch" 500 (the crm-calls convention).
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(sp.get('pageSize') || '25', 10) || 25));

    const conds: string[] = [];
    const params: any[] = [];
    const employeeId = s(sp.get('employee_id'));
    if (employeeId) {
      conds.push('b.employee_id = ?');
      params.push(employeeId);
    }
    if (sp.get('include_inactive') !== '1') conds.push('b.is_active = 1');
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const db = getDb();
    // Same WHERE + params feed COUNT(*) and the page query — total and rows
    // can never disagree.
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n FROM hr_bank_accounts b ${where}`)
      .get(...params) as { n: number };

    const raw = db
      .prepare(
        `SELECT b.*, e.full_name AS employee_name, e.employee_code
           FROM hr_bank_accounts b
           LEFT JOIN hr_employees e ON e.id = b.employee_id
           ${where}
          ORDER BY e.full_name COLLATE NOCASE, b.created_at DESC, b.id
          LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as BankRow[];

    // The tier decides what leaves the server: admin = full, everyone else =
    // masked. can_view_full lets the page label the column honestly.
    const full = canAdminHr(me);
    return Response.json({
      rows: raw.map((r) => serialize(r, full)),
      total: totalRow.n,
      page,
      pageSize,
      can_view_full: full,
    });
  } catch (e) {
    console.error('[hr-bank]', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load bank accounts' }, { status: 500 });
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

  const account_number = normAccount(body?.account_number);
  if (!account_number) {
    return Response.json({ error: 'Account number is required' }, { status: 400 });
  }
  if (account_number.length > 34) {
    return Response.json({ error: 'Account number looks too long' }, { status: 400 });
  }

  const ifsc = s(body?.ifsc).toUpperCase();
  if (!IFSC_RE.test(ifsc)) {
    return Response.json(
      { error: 'IFSC must be 4 letters, then 0, then 6 letters/digits (e.g. HDFC0001234)' },
      { status: 400 },
    );
  }

  // better-sqlite3 is synchronous — resolve every await BEFORE db.transaction.
  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();

    // FK-by-convention: validate the referenced employee exists on CREATE
    // (reads stay LEFT-JOIN tolerant; writes do not accept dangling ids).
    const emp = db
      .prepare('SELECT id FROM hr_employees WHERE id = ?')
      .get(employee_id) as any;
    if (!emp) {
      return Response.json({ error: 'Selected employee was not found' }, { status: 400 });
    }

    const dupe = db
      .prepare(
        `SELECT id FROM hr_bank_accounts
          WHERE employee_id = ? AND account_number = ? AND is_active = 1`,
      )
      .get(employee_id, account_number) as any;
    if (dupe) {
      return Response.json(
        { error: 'This account number is already on file for this employee' },
        { status: 409 },
      );
    }

    const id = generateId();
    const record = {
      id,
      employee_id,
      bank_name: s(body?.bank_name),
      account_holder: s(body?.account_holder),
      account_number,
      ifsc,
      branch: s(body?.branch),
      account_type: s(body?.account_type) || 'savings',
    };

    const create = db.transaction(() => {
      db.prepare(
        `INSERT INTO hr_bank_accounts
           (id, employee_id, bank_name, account_holder, account_number, ifsc, branch, account_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id, record.employee_id, record.bank_name, record.account_holder,
        record.account_number, record.ifsc, record.branch, record.account_type,
      );
      logAuditEvent(db, {
        event_type: 'hr.bank.create',
        entity_type: 'hr_bank_account',
        entity_id: id,
        actor_email: me.email,
        outlet_id: outletId,
        after: auditShape(record),
      });
    });
    create();

    const account = db.prepare(SELECT_ONE).get(id) as BankRow;
    // Caller is admin (gated above) — full serialization is correct here.
    return Response.json({ account: serialize(account, true) });
  } catch (e) {
    console.error('[hr-bank]', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to save bank account' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const id = s(body?.id);
  if (!id) return Response.json({ error: 'Bank account id is required' }, { status: 400 });

  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const existing = db
      .prepare('SELECT * FROM hr_bank_accounts WHERE id = ?')
      .get(id) as HrBankAccount | undefined;
    if (!existing) return Response.json({ error: 'Bank account not found' }, { status: 404 });

    const sets: string[] = [];
    const args: any[] = [];
    // Changing the number or IFSC invalidates any earlier verification.
    let resetVerification = false;

    if (body.account_number !== undefined) {
      const account_number = normAccount(body.account_number);
      if (!account_number) {
        return Response.json({ error: 'Account number is required' }, { status: 400 });
      }
      if (account_number.length > 34) {
        return Response.json({ error: 'Account number looks too long' }, { status: 400 });
      }
      if (account_number !== existing.account_number) {
        const dupe = db
          .prepare(
            `SELECT id FROM hr_bank_accounts
              WHERE employee_id = ? AND account_number = ? AND is_active = 1 AND id != ?`,
          )
          .get(existing.employee_id, account_number, id) as any;
        if (dupe) {
          return Response.json(
            { error: 'This account number is already on file for this employee' },
            { status: 409 },
          );
        }
        resetVerification = true;
      }
      sets.push('account_number = ?'); args.push(account_number);
    }

    if (body.ifsc !== undefined) {
      const ifsc = s(body.ifsc).toUpperCase();
      if (!IFSC_RE.test(ifsc)) {
        return Response.json(
          { error: 'IFSC must be 4 letters, then 0, then 6 letters/digits (e.g. HDFC0001234)' },
          { status: 400 },
        );
      }
      if (ifsc !== existing.ifsc) resetVerification = true;
      sets.push('ifsc = ?'); args.push(ifsc);
    }

    if (body.bank_name !== undefined) { sets.push('bank_name = ?'); args.push(s(body.bank_name)); }
    if (body.account_holder !== undefined) { sets.push('account_holder = ?'); args.push(s(body.account_holder)); }
    if (body.branch !== undefined) { sets.push('branch = ?'); args.push(s(body.branch)); }
    if (body.account_type !== undefined) {
      sets.push('account_type = ?'); args.push(s(body.account_type) || 'savings');
    }
    if (body.is_active !== undefined) {
      sets.push('is_active = ?'); args.push(body.is_active ? 1 : 0);
    }

    if (!sets.length) return Response.json({ error: 'Nothing to update' }, { status: 400 });

    if (resetVerification) {
      sets.push(`verify_status = 'unverified'`, `verified_by = ''`, `verified_at = ''`);
    }
    sets.push(`updated_at = datetime('now')`);

    const update = db.transaction(() => {
      db.prepare(`UPDATE hr_bank_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
      const after = db.prepare('SELECT * FROM hr_bank_accounts WHERE id = ?').get(id) as HrBankAccount;
      logAuditEvent(db, {
        event_type: 'hr.bank.update',
        entity_type: 'hr_bank_account',
        entity_id: id,
        actor_email: me.email,
        outlet_id: outletId,
        before: auditShape(existing),
        after: auditShape(after),
      });
    });
    update();

    const account = db.prepare(SELECT_ONE).get(id) as BankRow;
    return Response.json({ account: serialize(account, true) });
  } catch (e) {
    console.error('[hr-bank]', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update bank account' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const id = s(body?.id);
  if (!id) return Response.json({ error: 'Bank account id is required' }, { status: 400 });
  const action = s(body?.action);
  if (action !== 'verify' && action !== 'reject') {
    return Response.json({ error: 'Action must be verify or reject' }, { status: 400 });
  }

  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const existing = db
      .prepare('SELECT * FROM hr_bank_accounts WHERE id = ?')
      .get(id) as HrBankAccount | undefined;
    if (!existing) return Response.json({ error: 'Bank account not found' }, { status: 404 });

    const verify_status = action === 'verify' ? 'verified' : 'rejected';

    const decide = db.transaction(() => {
      db.prepare(
        `UPDATE hr_bank_accounts
            SET verify_status = ?, verified_by = ?, verified_at = datetime('now'),
                updated_at = datetime('now')
          WHERE id = ?`,
      ).run(verify_status, me.email, id);
      const after = db.prepare('SELECT * FROM hr_bank_accounts WHERE id = ?').get(id) as HrBankAccount;
      logAuditEvent(db, {
        event_type: action === 'verify' ? 'hr.bank.verify' : 'hr.bank.reject',
        entity_type: 'hr_bank_account',
        entity_id: id,
        actor_email: me.email,
        outlet_id: outletId,
        before: auditShape(existing),
        after: auditShape(after),
      });
    });
    decide();

    const account = db.prepare(SELECT_ONE).get(id) as BankRow;
    return Response.json({ account: serialize(account, true) });
  } catch (e) {
    console.error('[hr-bank]', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update verification' }, { status: 500 });
  }
}
