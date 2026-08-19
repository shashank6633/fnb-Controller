/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canManageHr, type HrOnboardingItem } from '@/lib/hr';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR Onboarding checklist (/api/hr/onboarding) — HRMS Phase 6.
 * Contract: docs/HRMS_DECISIONS.md. One hr_onboarding_items row per checklist
 * step per employee; `done` carries the state, done_by/done_at stamp who
 * ticked it (me.email — the house actor convention; employee_id is ALWAYS
 * hr_employees.id, the two never mix).
 *
 * GET   /api/hr/onboarding?employee_id= → { items, done, total, completion_pct }
 *       The employee's checklist ordered by sort_order. completion_pct is
 *       computed here so every surface reports the same number.
 * POST  /api/hr/onboarding { employee_id } → { items, done, total, completion_pct }
 *       Seeds the STANDARD checklist for the employee, skipping any items
 *       (by label) that already exist — re-seeding is safe and never
 *       duplicates or resets ticked rows. Employee validated → 400 named.
 * PATCH /api/hr/onboarding { id, done } → { item }
 *       Ticks/unticks one row: done=true stamps done_by/done_at, done=false
 *       clears them.
 *
 * Every verb gates on canManageHr — the proxy does NOT guard API GETs; this
 * handler is the security boundary (HRMS §2.1). Error bodies are GENERIC on
 * 500 (never e.message).
 */
export const dynamic = 'force-dynamic';

/** The standard checklist, in presentation order (sort_order = index). */
const STANDARD_ITEMS: readonly string[] = [
  'kyc',
  'bank',
  'documents',
  'offer_letter',
  'appointment_letter',
  'uniform',
  'id_card',
  'system_access',
  'sop_assignment',
  'training',
  'introduction',
];

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** The employee's checklist + completion rollup (one shape for GET and POST). */
function checklistPayload(db: import('better-sqlite3').Database, employeeId: string) {
  const items = db
    .prepare(
      `SELECT * FROM hr_onboarding_items WHERE employee_id = ? ORDER BY sort_order, item`,
    )
    .all(employeeId) as HrOnboardingItem[];
  const total = items.length;
  const done = items.filter((i) => !!i.done).length;
  const completion_pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return { items, done, total, completion_pct };
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }
  try {
    const employee_id = s(new URL(request.url).searchParams.get('employee_id'));
    if (!employee_id) {
      return Response.json({ error: 'Employee id is required' }, { status: 400 });
    }
    const db = getDb();
    return Response.json(checklistPayload(db, employee_id));
  } catch (e) {
    console.error('GET /api/hr/onboarding failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load the onboarding checklist' }, { status: 500 });
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
  const employee_id = s(body?.employee_id);
  if (!employee_id) return Response.json({ error: 'Employee is required' }, { status: 400 });

  // better-sqlite3 is synchronous — resolve every await BEFORE db.transaction.
  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();

    // Mapping contract: employee_id → hr_employees.id, validated on CREATE.
    const emp = db.prepare(`SELECT id FROM hr_employees WHERE id = ?`).get(employee_id) as any;
    if (!emp) return Response.json({ error: 'Selected employee was not found' }, { status: 400 });

    // Existing-check + inserts in ONE transaction so a double-submit can't
    // interleave and seed an item twice (no UNIQUE(employee_id, item) exists
    // in the schema — this transaction is the guard). All synchronous.
    const seeded: string[] = [];
    const seed = db.transaction(() => {
      const existing = new Set(
        (db
          .prepare(`SELECT item FROM hr_onboarding_items WHERE employee_id = ?`)
          .all(employee_id) as { item: string }[]).map((r) => r.item),
      );
      const ins = db.prepare(
        `INSERT INTO hr_onboarding_items (id, employee_id, item, sort_order)
         VALUES (?, ?, ?, ?)`,
      );
      STANDARD_ITEMS.forEach((item, i) => {
        if (existing.has(item)) return;
        ins.run(generateId(), employee_id, item, i);
        seeded.push(item);
      });
      if (seeded.length) {
        logAuditEvent(db, {
          event_type: 'hr.onboarding.seed',
          entity_type: 'hr_onboarding',
          entity_id: employee_id,
          actor_email: me.email,
          outlet_id: outletId,
          after: { employee_id, seeded },
        });
      }
    });
    seed();

    return Response.json(checklistPayload(db, employee_id));
  } catch (e) {
    console.error('POST /api/hr/onboarding failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to seed the onboarding checklist' }, { status: 500 });
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
  if (!id) return Response.json({ error: 'Checklist item id is required' }, { status: 400 });
  if (body?.done === undefined) {
    return Response.json({ error: 'done is required' }, { status: 400 });
  }
  const done = !!body.done;

  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const existing = db
      .prepare(`SELECT * FROM hr_onboarding_items WHERE id = ?`)
      .get(id) as HrOnboardingItem | undefined;
    if (!existing) return Response.json({ error: 'Checklist item not found' }, { status: 404 });

    // done=true stamps who/when; done=false clears both (an untick is a
    // correction, not history — the audit event below keeps the trail).
    if (done) {
      db.prepare(
        `UPDATE hr_onboarding_items
            SET done = 1, done_by = ?, done_at = datetime('now')
          WHERE id = ?`,
      ).run(me.email, id);
    } else {
      db.prepare(
        `UPDATE hr_onboarding_items SET done = 0, done_by = '', done_at = '' WHERE id = ?`,
      ).run(id);
    }

    const item = db
      .prepare(`SELECT * FROM hr_onboarding_items WHERE id = ?`)
      .get(id) as HrOnboardingItem;
    logAuditEvent(db, {
      event_type: 'hr.onboarding.item',
      entity_type: 'hr_onboarding_item',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      before: existing,
      after: item,
    });
    return Response.json({ item });
  } catch (e) {
    console.error('PATCH /api/hr/onboarding failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update the checklist item' }, { status: 500 });
  }
}
