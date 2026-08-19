/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canAdminHr } from '@/lib/hr';
import { computePayrollItem, finalizeRunGuard, payrollPeriodBounds } from '@/lib/hr-payroll';
import { reportServerError } from '@/lib/error-alerts';

/**
 * Payroll runs (/api/hr/payroll) — HRMS Phase 4, the ARCHITECTURE PROOF.
 * Contract: docs/HRMS_DECISIONS.md §5 (a run consumes attendance + leave +
 * structures + statutory configs + advances into FROZEN items; drafts are
 * recomputable, a finalized run is IMMUTABLE) and the db.ts Phases 3-7 block
 * (ledgers append; state lives in status columns; employee_id is ALWAYS
 * hr_employees.id, actors are ALWAYS me.email).
 *
 * THIS IS MONEY. Every verb (GET included) gates on canAdminHr — the proxy
 * does NOT protect API GETs (HRMS_DECISIONS §2.1); this handler is the
 * security boundary. Errors are GENERIC on the wire: e.message never leaves
 * the server (payroll internals are PII).
 *
 * The compute itself lives in src/lib/hr-payroll.ts (READ-ONLY, synchronous,
 * no hardcoded statutory rates). THIS route owns every write and every
 * transaction: it freezes computePayrollItem's output into hr_payroll_items,
 * and at finalize marks the advance installments that compute consumed.
 *
 * GET  ?period=YYYY-MM&page=&pageSize=
 *        → { rows, total, page, pageSize }
 *      Runs (newest period first), each with its items[] (employee_name /
 *      employee_code via LEFT JOIN — a dangling employee_id degrades to
 *      blank, never drops a money row). List items EXCLUDE detail_json
 *      (the trace is heavy); fetch one run for the full trace:
 * GET  ?run_id=<id> → { run }   (run.items[] carry detail_json — the frozen
 *      compute trace of every payslip line)
 *
 * POST { action: 'create', period, note? } → { run }
 *      Draft run for period (YYYY-MM), outlet stamped from the caller's
 *      current outlet. 409 when the period+outlet run already exists
 *      (UNIQUE(period, outlet_id) backstops the race). Also 409 when a run
 *      for the same period exists under a DIFFERENT outlet id while the
 *      venue has only one active outlet — that can only be the outlet-picker
 *      trap (the admin's view outlet changed between visits), and a second
 *      run would double every payslip.
 *
 * POST { action: 'compute', run_id } → { run, items, skipped, roster_count, note }
 *      DRAFT ONLY (finalized → 409, immutable). REPLACES the run's items in
 *      ONE transaction: delete + computePayrollItem per rostered employee +
 *      insert. The roster is every hr_employees row in a working status
 *      (active/probation/confirmed/notice_period — plus suspended, who are
 *      NOT computed but reported as skipped per the owner's suspension
 *      ruling, §8.4b) SCOPED TO THE RUN'S OUTLET: home_outlet_id matches
 *      run.outlet_id, or is '' (all outlets), or the employee is additionally
 *      assigned to the outlet via hr_employee_outlets. Employees homed at
 *      OTHER outlets are not skipped — they simply belong to that outlet's
 *      run; roster_count + note in the response make an empty compute
 *      explainable. Exit statuses (resigned/terminated/former) are not on
 *      the monthly roster — final settlement is the exit-clearance flow's
 *      job. NOBODY on the roster is silently dropped: every rostered
 *      employee either gets an item or a {employee_id, reason} entry in
 *      skipped[], and the skipped list is frozen into the audit event.
 *      Statutory configs: only state='' (all-India) rows apply in v1 —
 *      employees carry no state, and hr-payroll.ts selects state='' rows
 *      only. Compute WRITES NOTHING to advances — installment consumption is
 *      only recorded in each item's trace until finalize makes it real.
 *
 * POST { action: 'finalize', run_id } → { run, recovered_installments, recovered_amount }
 *      finalizeRunGuard (draft + has items) checked INSIDE the transaction,
 *      then in the SAME transaction: every advance installment the computed
 *      items consumed is marked recovered (status-guarded — if any has
 *      changed since compute, the whole finalize rolls back as a 409 asking
 *      for a recompute; a payslip must never deduct an installment the
 *      ledger no longer owes), each parent hr_advances.recovered_amount is
 *      bumped, and the run flips draft → finalized. From then on compute
 *      returns 409: the items are frozen payslips.
 *
 * Audit: hr.payroll.create / hr.payroll.compute / hr.payroll.finalize.
 */
export const dynamic = 'force-dynamic';

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** Safe JSON.parse → value or null (detail_json/deductions_json are ours,
 *  but a money path never trusts a parse). */
function parseJsonSafe(text: string | null | undefined): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Money value in integer paise (float-dust-free ledger arithmetic). */
function paise(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Round to 2 decimals for published totals. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * The monthly payroll roster: every working status, SCOPED TO THE RUN'S
 * OUTLET (home_outlet_id = run.outlet_id, or '' = all outlets, or an
 * hr_employee_outlets assignment to the outlet — employees homed elsewhere
 * belong to that outlet's run and are NOT reported as skipped here).
 * 'suspended' rides along so the run can REPORT those employees as skipped
 * (owner ruling §8.4b: suspension halts work — it must be visible on the
 * run, never silent). Exit statuses (resigned/terminated/former) are
 * deliberately absent: final settlement belongs to exit clearance, not the
 * monthly run.
 */
const PAYROLL_ROSTER_STATUSES = [
  'active',
  'probation',
  'confirmed',
  'notice_period',
  'suspended',
] as const;

/** Item projection for LISTS — everything except the heavy detail_json.
 *  LEFT JOIN + COALESCE: a dangling employee_id degrades to blank name,
 *  never a dropped money row. */
const ITEM_LIST_SELECT = `
  SELECT i.id, i.run_id, i.employee_id, i.paid_days, i.lop_days,
         i.overtime_minutes, i.earnings_json, i.deductions_json, i.gross, i.net,
         COALESCE(e.full_name, '') AS employee_name,
         COALESCE(e.employee_code, '') AS employee_code
  FROM hr_payroll_items i
  LEFT JOIN hr_employees e ON e.id = i.employee_id
`;

/** Item projection for the single-run GET — includes the frozen trace. */
const ITEM_DETAIL_SELECT = `
  SELECT i.*, COALESCE(e.full_name, '') AS employee_name,
         COALESCE(e.employee_code, '') AS employee_code
  FROM hr_payroll_items i
  LEFT JOIN hr_employees e ON e.id = i.employee_id
`;

const ITEM_ORDER = `ORDER BY employee_name COLLATE NOCASE, i.id`;

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin access required' }, { status: 403 });

  try {
    const sp = new URL(request.url).searchParams;
    const db = getDb();

    // ── detail mode: one run, items WITH the frozen compute trace ──
    const run_id = s(sp.get('run_id'));
    if (run_id) {
      const run = db.prepare('SELECT * FROM hr_payroll_runs WHERE id = ?').get(run_id) as any;
      if (!run) return Response.json({ error: 'Payroll run not found' }, { status: 404 });
      const items = db
        .prepare(`${ITEM_DETAIL_SELECT} WHERE i.run_id = ? ${ITEM_ORDER}`)
        .all(run_id) as any[];
      return Response.json({ run: { ...run, items } });
    }

    // ── list mode: runs (+ items sans trace), newest period first ──
    // parseInt (not Number) so a float can't reach LIMIT/OFFSET and trip
    // SQLite's "datatype mismatch" 500 (the crm-calls convention).
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(sp.get('pageSize') || '25', 10) || 25));

    const clauses: string[] = [];
    const params: any[] = [];
    const period = s(sp.get('period'));
    if (period) {
      if (!payrollPeriodBounds(period)) {
        return Response.json({ error: 'Period must be a valid month (YYYY-MM)' }, { status: 400 });
      }
      clauses.push('period = ?');
      params.push(period);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    // The SAME clause+params feed COUNT(*) and the page query, so total and
    // rows can never disagree.
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n FROM hr_payroll_runs ${where}`)
      .get(...params) as { n: number };
    const rows = db
      .prepare(
        `SELECT * FROM hr_payroll_runs ${where}
         ORDER BY period DESC, created_at DESC, id
         LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as any[];

    // Attach each run's items in ONE IN() query for the page, grouped in
    // memory — not a query per run (the advances-route idiom).
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const items = db
        .prepare(
          `${ITEM_LIST_SELECT}
           WHERE i.run_id IN (${ids.map(() => '?').join(',')})
           ${ITEM_ORDER}`,
        )
        .all(...ids) as any[];
      const byRun = new Map<string, any[]>();
      for (const it of items) {
        const list = byRun.get(it.run_id);
        if (list) list.push(it);
        else byRun.set(it.run_id, [it]);
      }
      for (const r of rows) r.items = byRun.get(r.id) ?? [];
    }

    return Response.json({ rows, total: totalRow.n, page, pageSize });
  } catch (e) {
    console.error('[hr-payroll] GET failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load payroll runs' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin access required' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled by field checks below */ }

  const action = s(body?.action);
  try {
    if (action === 'create') return await createRun(me, body, request);
    if (action === 'compute') return computeRun(me, body, request);
    if (action === 'finalize') return finalizeRun(me, body, request);
    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    console.error('[hr-payroll] POST failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Payroll action failed' }, { status: 500 });
  }
}

/* ------------------------------------------------------------------ *
 * create — a draft run for a period (UNIQUE(period, outlet_id))
 * ------------------------------------------------------------------ */

async function createRun(me: any, body: any, request: Request): Promise<Response> {
  const period = s(body?.period);
  if (!payrollPeriodBounds(period)) {
    return Response.json({ error: 'A valid payroll period (YYYY-MM) is required' }, { status: 400 });
  }
  const note = s(body?.note);

  // Resolve every await BEFORE db.transaction — an await inside the callback
  // silently breaks better-sqlite3 atomicity.
  const outletId = (await getCurrentOutletId()) || '';

  try {
    const db = getDb();

    // Friendly pre-check; UNIQUE(period, outlet_id) still backstops the race
    // and is caught below.
    const dupe = db
      .prepare('SELECT id FROM hr_payroll_runs WHERE period = ? AND outlet_id = ?')
      .get(period, outletId) as any;
    if (dupe) {
      return Response.json(
        { error: `A payroll run for ${period} already exists for this outlet` },
        { status: 409 },
      );
    }

    // Outlet-picker trap: when the venue has ONLY ONE active outlet, a run
    // for the same period under a DIFFERENT outlet id can only mean the
    // caller's outlet view changed between visits — a second run would
    // double every payslip. Refuse with a plain explanation.
    const otherOutletRun = db
      .prepare('SELECT id FROM hr_payroll_runs WHERE period = ? AND outlet_id <> ? LIMIT 1')
      .get(period, outletId) as any;
    if (otherOutletRun) {
      const activeOutlets = db
        .prepare('SELECT COUNT(*) AS n FROM outlets WHERE is_active = 1')
        .get() as { n: number };
      if (activeOutlets.n <= 1) {
        return Response.json(
          {
            error:
              `A payroll run for ${period} already exists under a different outlet. ` +
              'This venue has a single active outlet, so your outlet picker has likely changed — ' +
              'switch it back and use the existing run instead of creating a duplicate.',
          },
          { status: 409 },
        );
      }
    }

    const id = generateId();
    const record = {
      id,
      period,
      outlet_id: outletId,
      status: 'draft',
      note,
      created_by: me.email, // actor = me.email, NEVER an employee id
    };

    const create = db.transaction(() => {
      db.prepare(
        `INSERT INTO hr_payroll_runs (id, period, outlet_id, status, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, period, outletId, 'draft', note, me.email);
      logAuditEvent(db, {
        event_type: 'hr.payroll.create',
        entity_type: 'hr_payroll_run',
        entity_id: id,
        actor_email: me.email,
        outlet_id: outletId || null,
        after: record,
      });
    });
    try {
      create();
    } catch (e: any) {
      if (String(e?.code || '').startsWith('SQLITE_CONSTRAINT')) {
        return Response.json(
          { error: `A payroll run for ${period} already exists for this outlet` },
          { status: 409 },
        );
      }
      throw e;
    }

    const run = db.prepare('SELECT * FROM hr_payroll_runs WHERE id = ?').get(id) as any;
    return Response.json({ run: { ...run, items: [] } });
  } catch (e) {
    console.error('[hr-payroll] create failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to create the payroll run' }, { status: 500 });
  }
}

/* ------------------------------------------------------------------ *
 * compute — REPLACE a draft run's items in one transaction
 * ------------------------------------------------------------------ */

function computeRun(me: any, body: any, request: Request): Response {
  const run_id = s(body?.run_id);
  if (!run_id) return Response.json({ error: 'Run id is required' }, { status: 400 });

  try {
    const db = getDb();
    const run = db.prepare('SELECT * FROM hr_payroll_runs WHERE id = ?').get(run_id) as any;
    if (!run) return Response.json({ error: 'Payroll run not found' }, { status: 404 });
    if (run.status !== 'draft') {
      return Response.json(
        { error: 'This payroll run is finalized — its payslips are immutable and cannot be recomputed' },
        { status: 409 },
      );
    }

    // The roster (see PAYROLL_ROSTER_STATUSES), scoped to the RUN'S outlet:
    // runs are per-outlet (UNIQUE(period, outlet_id)), so an outlet-blind
    // roster would compute every employee into every outlet's run for the
    // period. home_outlet_id = '' means "all outlets"; hr_employee_outlets
    // covers additional assignments. Deterministic order so reruns produce
    // identical item ordering.
    const roster = db
      .prepare(
        `SELECT id, employee_code, full_name, status
         FROM hr_employees
         WHERE status IN (${PAYROLL_ROSTER_STATUSES.map(() => '?').join(',')})
           AND (home_outlet_id = ? OR home_outlet_id = ''
                OR id IN (SELECT employee_id FROM hr_employee_outlets WHERE outlet_id = ?))
         ORDER BY full_name COLLATE NOCASE, id`,
      )
      .all(...PAYROLL_ROSTER_STATUSES, run.outlet_id, run.outlet_id) as Array<{
      id: string;
      employee_code: string;
      full_name: string;
      status: string;
    }>;

    const skipped: Array<{
      employee_id: string;
      employee_code: string;
      full_name: string;
      reason: string;
    }> = [];
    let computed = 0;
    let grossTotalP = 0;
    let netTotalP = 0;

    const insertItem = db.prepare(
      `INSERT INTO hr_payroll_items (
         id, run_id, employee_id, paid_days, lop_days, overtime_minutes,
         earnings_json, deductions_json, gross, net, detail_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // Everything inside is synchronous: computePayrollItem is read-only and
    // await-free by contract (hr-payroll.ts header), so delete + compute +
    // insert is ONE atomic replace.
    const tx = db.transaction(() => {
      // Draft re-check inside the transaction — the status flip to finalized
      // must never race a replace of frozen payslips.
      const fresh = db
        .prepare('SELECT status FROM hr_payroll_runs WHERE id = ?')
        .get(run_id) as any;
      if (!fresh || fresh.status !== 'draft') throw new Error('RUN_NOT_DRAFT');

      db.prepare('DELETE FROM hr_payroll_items WHERE run_id = ?').run(run_id);

      for (const emp of roster) {
        // Owner ruling §8.4b: suspension halts work. Reported, not computed
        // — and never silently dropped.
        if (emp.status === 'suspended') {
          skipped.push({
            employee_id: emp.id,
            employee_code: emp.employee_code,
            full_name: emp.full_name,
            reason: 'Employee is suspended — release the suspension to include them in payroll',
          });
          continue;
        }

        const result = computePayrollItem(db, emp.id, run.period);
        if (result.skip) {
          skipped.push({
            employee_id: emp.id,
            employee_code: emp.employee_code,
            full_name: emp.full_name,
            reason: result.reason,
          });
          continue;
        }

        insertItem.run(
          generateId(), run_id, emp.id, result.paid_days, result.lop_days,
          result.overtime_minutes, result.earnings_json, result.deductions_json,
          result.gross, result.net, result.detail_json,
        );
        computed += 1;
        grossTotalP += paise(result.gross);
        netTotalP += paise(result.net);
      }

      // The skipped list is frozen into the audit trail — the durable record
      // that nobody fell off the run unnoticed.
      logAuditEvent(db, {
        event_type: 'hr.payroll.compute',
        entity_type: 'hr_payroll_run',
        entity_id: run_id,
        actor_email: me.email,
        outlet_id: run.outlet_id || null,
        after: {
          period: run.period,
          roster: roster.length,
          computed,
          gross_total: grossTotalP / 100,
          net_total: netTotalP / 100,
          skipped,
        },
      });
    });
    try {
      tx();
    } catch (e) {
      if (e instanceof Error && e.message === 'RUN_NOT_DRAFT') {
        return Response.json(
          { error: 'This payroll run is finalized — its payslips are immutable and cannot be recomputed' },
          { status: 409 },
        );
      }
      throw e;
    }

    const freshRun = db.prepare('SELECT * FROM hr_payroll_runs WHERE id = ?').get(run_id) as any;
    const items = db
      .prepare(`${ITEM_LIST_SELECT} WHERE i.run_id = ? ${ITEM_ORDER}`)
      .all(run_id) as any[];
    // roster_count + note make an empty compute explainable: employees homed
    // at OTHER outlets are not "skipped" — they belong to that outlet's run.
    return Response.json({
      run: freshRun,
      items,
      skipped,
      roster_count: roster.length,
      note:
        'Roster is scoped to this run’s outlet: employees whose home outlet matches, ' +
        'is blank (all outlets), or who are additionally assigned to it. ' +
        'Employees homed at other outlets belong to that outlet’s run.',
    });
  } catch (e) {
    console.error('[hr-payroll] compute failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to compute the payroll run' }, { status: 500 });
  }
}

/* ------------------------------------------------------------------ *
 * finalize — guard + mark recovered installments + flip, in ONE txn
 * ------------------------------------------------------------------ */

function finalizeRun(me: any, body: any, request: Request): Response {
  const run_id = s(body?.run_id);
  if (!run_id) return Response.json({ error: 'Run id is required' }, { status: 400 });

  try {
    const db = getDb();
    const run = db.prepare('SELECT * FROM hr_payroll_runs WHERE id = ?').get(run_id) as any;
    if (!run) return Response.json({ error: 'Payroll run not found' }, { status: 404 });

    let recoveredCount = 0;
    let recoveredP = 0;
    let grossTotalP = 0;
    let netTotalP = 0;
    let itemCount = 0;

    const markRecovered = db.prepare(
      `UPDATE hr_advance_installments
       SET status = 'recovered', recovered_at = datetime('now'), payroll_item_id = ?
       WHERE id = ? AND status = 'due'`,
    );

    const tx = db.transaction(() => {
      // Guard on a FRESH read inside the transaction so the precondition
      // check and the status flip are atomic (hr-payroll.ts contract).
      const fresh = db
        .prepare('SELECT id, status FROM hr_payroll_runs WHERE id = ?')
        .get(run_id) as any;
      const guardMsg = finalizeRunGuard(db, fresh);
      if (guardMsg) throw new Error(`GUARD:${guardMsg}`);

      const items = db
        .prepare(
          `SELECT id, employee_id, deductions_json, detail_json, gross, net
           FROM hr_payroll_items WHERE run_id = ?`,
        )
        .all(run_id) as any[];
      itemCount = items.length;

      // Per-advance recovery totals in integer paise — no float dust in a
      // money ledger.
      const byAdvanceP = new Map<string, number>();

      for (const item of items) {
        grossTotalP += paise(item.gross);
        netTotalP += paise(item.net);

        // The installments this payslip consumed live in its frozen trace
        // (hr-payroll.ts: advance_recovery.applied). The deductions line is
        // cross-checked against the trace — a payslip must never deduct
        // recovery money the ledger cannot account for.
        const detail = parseJsonSafe(item.detail_json) as any;
        const applied: Array<{ id: string; advance_id: string; amount: number }> =
          detail && Array.isArray(detail?.advance_recovery?.applied)
            ? detail.advance_recovery.applied
            : [];

        const deductions = parseJsonSafe(item.deductions_json);
        const recoveryLineP = Array.isArray(deductions)
          ? deductions.reduce(
              (sum: number, d: any) =>
                d && d.label === 'Advance Recovery' ? sum + paise(d.amount) : sum,
              0,
            )
          : 0;
        const appliedP = applied.reduce((sum, inst) => sum + paise(inst?.amount), 0);
        if (recoveryLineP !== appliedP) {
          throw new Error(
            'GUARD:A payslip’s advance-recovery deduction does not match its compute trace — recompute the run before finalizing',
          );
        }

        for (const inst of applied) {
          const instId = s(inst?.id);
          const advanceId = s(inst?.advance_id);
          const amountP = paise(inst?.amount);
          if (!instId || !advanceId || amountP <= 0) {
            throw new Error(
              'GUARD:A payslip’s advance-recovery trace is unreadable — recompute the run before finalizing',
            );
          }
          // Status-guarded claim: if the installment was waived or recovered
          // since compute, the payslip is stale — the WHOLE finalize rolls
          // back rather than deducting money the ledger no longer owes.
          const res = markRecovered.run(item.id, instId);
          if (res.changes !== 1) {
            throw new Error(
              'GUARD:Advance installments changed since this run was computed — recompute the run before finalizing',
            );
          }
          byAdvanceP.set(advanceId, (byAdvanceP.get(advanceId) ?? 0) + amountP);
          recoveredCount += 1;
          recoveredP += amountP;
        }
      }

      // Bump each parent advance's recovered lifetime total (the ledger rows
      // above are the detail; this is the running sum /close reads).
      for (const [advanceId, amountP] of byAdvanceP) {
        db.prepare(
          `UPDATE hr_advances
           SET recovered_amount = ROUND(recovered_amount + ?, 2)
           WHERE id = ?`,
        ).run(amountP / 100, advanceId);
      }

      // The flip — status-guarded so a lost race rolls everything back.
      const flip = db
        .prepare(
          `UPDATE hr_payroll_runs
           SET status = 'finalized', finalized_by = ?, finalized_at = datetime('now')
           WHERE id = ? AND status = 'draft'`,
        )
        .run(me.email, run_id);
      if (flip.changes !== 1) {
        throw new Error('GUARD:This payroll run is already finalized');
      }

      logAuditEvent(db, {
        event_type: 'hr.payroll.finalize',
        entity_type: 'hr_payroll_run',
        entity_id: run_id,
        actor_email: me.email,
        outlet_id: run.outlet_id || null,
        before: { status: 'draft' },
        after: {
          status: 'finalized',
          period: run.period,
          items: itemCount,
          gross_total: grossTotalP / 100,
          net_total: netTotalP / 100,
          recovered_installments: recoveredCount,
          recovered_amount: recoveredP / 100,
        },
      });
    });
    try {
      tx();
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('GUARD:')) {
        const msg = e.message.slice('GUARD:'.length);
        return Response.json(
          { error: msg },
          { status: msg === 'Payroll run not found' ? 404 : 409 },
        );
      }
      throw e;
    }

    const freshRun = db.prepare('SELECT * FROM hr_payroll_runs WHERE id = ?').get(run_id) as any;
    return Response.json({
      run: freshRun,
      recovered_installments: recoveredCount,
      recovered_amount: round2(recoveredP / 100),
    });
  } catch (e) {
    console.error('[hr-payroll] finalize failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to finalize the payroll run' }, { status: 500 });
  }
}
