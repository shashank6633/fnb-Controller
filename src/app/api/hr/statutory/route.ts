/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canAdminHr } from '@/lib/hr';
import type { HrStatutoryConfig } from '@/lib/hr';
import { reportServerError } from '@/lib/error-alerts';

/**
 * Statutory configs (/api/hr/statutory) — HRMS Phase 4.
 * Contract: docs/HRMS_DECISIONS.md §5 + owner spec §19/§20: statutory rates
 * are CONFIG ROWS — never constants in code, never columns on the employee —
 * scoped by state/employee_category, effective-dated, and read by the payroll
 * compute (src/lib/hr-payroll.ts) as "the row effective on day D".
 *
 * THIS IS MONEY CONFIG. Every verb (GET included) gates on canAdminHr — the
 * proxy does NOT protect API GETs (HRMS_DECISIONS §2.1); this handler is the
 * security boundary.
 *
 * config_json shapes per kind — the read contract src/lib/hr-payroll.ts
 * ACTUALLY computes against (rates in percent, caps in ₹/month; extra keys
 * are ignored, missing keys are treated as 0 by the payroll compute):
 *   pf                { percent_of_basic, wage_cap }
 *                       — base = earned (prorated) basic, capped at wage_cap
 *                         when > 0 (0 = no cap)
 *   esi               { percent_of_gross, gross_cap }
 *                       — gross_cap is an ELIGIBILITY ceiling: monthly gross
 *                         above it means NO ESI at all, not a capped base
 *   professional_tax  { slabs: [{ upto, amount }] }
 *                       — flat per-month amount matched ascending against the
 *                         earned gross; upto <= 0 = open (no upper bound)
 *   tds / bonus / gratuity / min_wage — stored for reference only; the v1
 *                       payroll compute does NOT read them.
 * STATE RULE (v1): employees carry no state, so payroll applies ONLY
 * state = '' (all-India) rows. Leave State empty to apply; state-scoped
 * rates need employee state data, a later phase.
 * The route validates config_json is a JSON OBJECT and caps its size; the
 * per-kind field semantics live in hr-payroll.ts (kept in sync with this
 * header — change them together).
 *
 * Effective dating (the append-only money rule, db.ts Phases 3-7 block):
 *  · A new config INSERTs; old rates are never edited. Creating a config for
 *    a scope (kind + state + employee_category) that already has an OPEN row
 *    (effective_to = '') closes that row to the day before the new
 *    effective_from IN THE SAME TRANSACTION — the only write old rows ever
 *    receive. The new row must start AFTER the open row starts (else 409).
 *  · PUT can only close/reopen a row (effective_to) or toggle is_active;
 *    kind/state/category/effective_from/config_json edits are refused with a
 *    400 — the fix for a wrong rate is a new forward-dated row.
 *  · DELETE is a soft deactivate (is_active = 0); rows are never removed.
 *
 * GET  ?kind=&state=&employee_category=&active_on=YYYY-MM-DD&
 *      include_inactive=1&page=&pageSize=
 *        → { rows, total, page, pageSize }
 *      Only active rows unless include_inactive=1. active_on=D narrows to
 *      rows in force on day D (effective_from ≤ D, effective_to '' or ≥ D).
 * POST { kind, state?, employee_category?, effective_from, effective_to?,
 *        config_json } → { config }        (409 on a duplicate scope+start)
 * PUT  { id, effective_to?, is_active? } → { config }
 * DELETE ?id= (or { id }) → { ok: true }   (soft deactivate)
 *
 * Audit: hr.statutory.create / hr.statutory.update / hr.statutory.deactivate.
 * Errors are GENERIC on the wire; e.message never leaves the server.
 */
export const dynamic = 'force-dynamic';

/**
 * All values hr_statutory_configs.kind accepts. Mirrors the HrStatutoryConfig
 * union in src/lib/hr.ts and the db.ts column comment EXACTLY (hr.ts ships
 * the type but no runtime array for this vocab, so the list lives here).
 */
const STATUTORY_KINDS = [
  'pf',
  'esi',
  'professional_tax',
  'tds',
  'bonus',
  'gratuity',
  'min_wage',
] as const;

const CONFIG_JSON_MAX_CHARS = 20_000;

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

/**
 * Normalise config_json input (object, or a JSON string of one) to its
 * canonical serialized form. Returns null when it is not a plain JSON object
 * or exceeds the size cap. Per-kind field semantics are hr-payroll.ts's job.
 */
function parseConfigJson(v: unknown): string | null {
  let obj: unknown = v;
  if (typeof v === 'string') {
    if (v.trim() === '') return '{}';
    try { obj = JSON.parse(v); } catch { return null; }
  }
  if (obj === undefined || obj === null) return '{}';
  if (typeof obj !== 'object' || Array.isArray(obj)) return null;
  const serialized = JSON.stringify(obj);
  if (serialized.length > CONFIG_JSON_MAX_CHARS) return null;
  return serialized;
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  try {
    const sp = new URL(request.url).searchParams;

    // parseInt (not Number) so a float can't reach LIMIT/OFFSET and trip
    // SQLite's "datatype mismatch" 500 (the crm-calls convention).
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(sp.get('pageSize') || '25', 10) || 25));

    const conds: string[] = [];
    const params: any[] = [];

    const kind = s(sp.get('kind'));
    if (kind) {
      if (!(STATUTORY_KINDS as readonly string[]).includes(kind)) {
        return Response.json({ error: 'Invalid statutory kind' }, { status: 400 });
      }
      conds.push('kind = ?');
      params.push(kind);
    }
    const state = s(sp.get('state'));
    if (state) {
      conds.push('state = ?');
      params.push(state);
    }
    const employee_category = s(sp.get('employee_category'));
    if (employee_category) {
      conds.push('employee_category = ?');
      params.push(employee_category);
    }
    if (sp.get('include_inactive') !== '1') {
      conds.push('is_active = 1');
    }
    const active_on = s(sp.get('active_on'));
    if (active_on) {
      if (!isYmd(active_on)) {
        return Response.json({ error: 'active_on must be a valid date (YYYY-MM-DD)' }, { status: 400 });
      }
      conds.push(`effective_from <= ? AND (effective_to = '' OR effective_to >= ?)`);
      params.push(active_on, active_on);
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const db = getDb();
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n FROM hr_statutory_configs ${where}`)
      .get(...params) as { n: number };
    const rows = db
      .prepare(
        `SELECT * FROM hr_statutory_configs ${where}
         ORDER BY kind, state, employee_category, effective_from DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize);

    return Response.json({ rows, total: totalRow.n, page, pageSize });
  } catch (e) {
    console.error('[hr-statutory]', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load statutory configs' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled by field checks below */ }

  const kind = s(body?.kind);
  if (!(STATUTORY_KINDS as readonly string[]).includes(kind)) {
    return Response.json({ error: 'Invalid statutory kind' }, { status: 400 });
  }

  const state = s(body?.state);                       // '' = all-India
  const employee_category = s(body?.employee_category);

  const effective_from = s(body?.effective_from);
  if (!isYmd(effective_from)) {
    return Response.json({ error: 'A valid effective date (YYYY-MM-DD) is required' }, { status: 400 });
  }
  const effective_to = s(body?.effective_to);         // '' = open (current)
  if (effective_to !== '') {
    if (!isYmd(effective_to)) {
      return Response.json({ error: 'Effective end date must be a valid date (YYYY-MM-DD)' }, { status: 400 });
    }
    if (effective_to < effective_from) {
      return Response.json({ error: 'Effective end date cannot be before the start date' }, { status: 400 });
    }
  }

  const config_json = parseConfigJson(body?.config_json);
  if (config_json === null) {
    return Response.json(
      { error: 'Config must be a JSON object (see the per-kind shapes on the statutory page)' },
      { status: 400 },
    );
  }

  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();

    // Duplicate scope+start → 409 (human message, house convention).
    const dupe = db
      .prepare(
        `SELECT id FROM hr_statutory_configs
         WHERE kind = ? AND state = ? AND employee_category = ?
           AND effective_from = ? AND is_active = 1`,
      )
      .get(kind, state, employee_category, effective_from) as any;
    if (dupe) {
      return Response.json(
        { error: 'An active config with this kind, scope and effective date already exists' },
        { status: 409 },
      );
    }

    // The open row for this scope (effective_to = '') is the one the new
    // config supersedes. Statutory history is forward-dated: the new row
    // must start after the open row starts.
    const openPrior = db
      .prepare(
        `SELECT * FROM hr_statutory_configs
         WHERE kind = ? AND state = ? AND employee_category = ?
           AND is_active = 1 AND effective_to = ''
         ORDER BY effective_from DESC
         LIMIT 1`,
      )
      .get(kind, state, employee_category) as HrStatutoryConfig | undefined;

    if (openPrior && effective_from <= openPrior.effective_from) {
      return Response.json(
        {
          error: `A config for this scope already starts on ${openPrior.effective_from} — the new one must start after it`,
        },
        { status: 409 },
      );
    }

    const id = generateId();
    const record = {
      id,
      kind,
      state,
      employee_category,
      effective_from,
      effective_to,
      config_json,
      is_active: 1,
      created_by: me.email,                 // actor = me.email (house convention)
    };

    // Close-prior + insert + audit in ONE transaction (all awaits resolved
    // above; everything inside is synchronous). Closing effective_to is the
    // only write an old rate row ever receives.
    const create = db.transaction(() => {
      if (openPrior) {
        db.prepare('UPDATE hr_statutory_configs SET effective_to = ? WHERE id = ?')
          .run(dayBefore(effective_from), openPrior.id);
      }
      db.prepare(
        `INSERT INTO hr_statutory_configs (
           id, kind, state, employee_category, effective_from, effective_to,
           config_json, is_active, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id, record.kind, record.state, record.employee_category,
        record.effective_from, record.effective_to, record.config_json,
        record.is_active, record.created_by,
      );
      logAuditEvent(db, {
        event_type: 'hr.statutory.create',
        entity_type: 'hr_statutory_config',
        entity_id: id,
        actor_email: me.email,
        outlet_id: outletId,
        before: openPrior,
        after: record,
      });
    });
    create();

    const config = db.prepare('SELECT * FROM hr_statutory_configs WHERE id = ?').get(id);
    return Response.json({ config });
  } catch (e) {
    console.error('[hr-statutory]', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to create statutory config' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled by field checks below */ }

  const id = s(body?.id);
  if (!id) return Response.json({ error: 'Config id is required' }, { status: 400 });

  // Append-only guard: rates and scope are immutable on an existing row —
  // the fix for a wrong rate is a NEW forward-dated config.
  for (const frozen of ['kind', 'state', 'employee_category', 'effective_from', 'config_json']) {
    if (body?.[frozen] !== undefined) {
      return Response.json(
        { error: 'Statutory rates are append-only — create a new config with a new effective date instead' },
        { status: 400 },
      );
    }
  }

  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const existing = db
      .prepare('SELECT * FROM hr_statutory_configs WHERE id = ?')
      .get(id) as HrStatutoryConfig | undefined;
    if (!existing) return Response.json({ error: 'Config not found' }, { status: 404 });

    const sets: string[] = [];
    const args: any[] = [];

    if (body?.effective_to !== undefined) {
      const effective_to = s(body.effective_to);      // '' reopens the row
      if (effective_to !== '') {
        if (!isYmd(effective_to)) {
          return Response.json({ error: 'Effective end date must be a valid date (YYYY-MM-DD)' }, { status: 400 });
        }
        if (effective_to < existing.effective_from) {
          return Response.json({ error: 'Effective end date cannot be before the start date' }, { status: 400 });
        }
      }
      sets.push('effective_to = ?');
      args.push(effective_to);
    }
    if (body?.is_active !== undefined) {
      sets.push('is_active = ?');
      args.push(body.is_active ? 1 : 0);
    }
    if (!sets.length) return Response.json({ error: 'Nothing to update' }, { status: 400 });

    db.prepare(`UPDATE hr_statutory_configs SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);

    const config = db.prepare('SELECT * FROM hr_statutory_configs WHERE id = ?').get(id);
    logAuditEvent(db, {
      event_type: 'hr.statutory.update',
      entity_type: 'hr_statutory_config',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      before: existing,
      after: config,
    });
    return Response.json({ config });
  } catch (e) {
    console.error('[hr-statutory]', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update statutory config' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  // House style is ?id= (vendors, tasks/*); accept a { id } body too so
  // neither caller shape breaks (the designations-route convention).
  const url = new URL(request.url);
  let id = s(url.searchParams.get('id'));
  if (!id) {
    try {
      const body: any = await request.json();
      id = s(body?.id);
    } catch { /* no body — handled below */ }
  }
  if (!id) return Response.json({ error: 'Config id is required' }, { status: 400 });

  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const existing = db
      .prepare('SELECT * FROM hr_statutory_configs WHERE id = ?')
      .get(id) as HrStatutoryConfig | undefined;
    if (!existing) return Response.json({ error: 'Config not found' }, { status: 404 });

    // Soft deactivate only — statutory history is never removed; payroll
    // recomputes of old periods still need the row.
    db.prepare('UPDATE hr_statutory_configs SET is_active = 0 WHERE id = ?').run(id);
    logAuditEvent(db, {
      event_type: 'hr.statutory.deactivate',
      entity_type: 'hr_statutory_config',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      before: existing,
      after: { ...existing, is_active: 0 },
    });
    return Response.json({ ok: true });
  } catch (e) {
    console.error('[hr-statutory]', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to deactivate statutory config' }, { status: 500 });
  }
}
