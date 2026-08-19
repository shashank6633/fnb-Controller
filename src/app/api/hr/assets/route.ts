/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canManageHr, isHrAssetKind, type HrAsset } from '@/lib/hr';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR Asset register (/api/hr/assets) — HRMS Phase 6.
 * Contract: docs/HRMS_DECISIONS.md. hr_asset_history is an APPEND-ONLY
 * movement ledger — every PATCH transition writes a history row in the SAME
 * transaction as the status change; nothing here deletes or rewrites either
 * table (there is deliberately no DELETE verb — a retired asset is a status,
 * not a vanished row).
 *
 * GET   /api/hr/assets?id=            → { asset, history }
 *       /api/hr/assets?q=&status=&kind=&employee_id=&page=&pageSize=
 *                                     → { rows, total, page, pageSize }
 *       Rows LEFT JOIN hr_employees for holder_name / holder_code — a
 *       dangling employee_id degrades to blank, never drops the asset.
 * POST  /api/hr/assets { name, kind?, tag?, note? } → { asset }
 *       Created in store, unissued (issue is a PATCH action, never part of
 *       create). 409 on a duplicate non-empty tag.
 * PUT   /api/hr/assets { id, name?, kind?, tag?, note? } → { asset }
 *       Label edits only — status/employee_id move ONLY through PATCH.
 * PATCH /api/hr/assets { id, action, employee_id?, note? } → { asset }
 *       action ∈ issue|return|damaged|lost|repaired. issue REQUIRES an
 *       employee_id (validated → 400 named message) and refuses an already
 *       issued asset; return clears the holder; repaired puts the asset back
 *       in store. Transition + ledger append + audit run in ONE transaction.
 *
 * Every verb gates on canManageHr — the proxy does NOT guard API GETs; this
 * handler is the security boundary (HRMS §2.1). Error bodies are GENERIC on
 * 500 (never e.message).
 */
export const dynamic = 'force-dynamic';

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** PATCH action → hr_assets.status + hr_asset_history.action. */
const TRANSITIONS = {
  issue: { status: 'issued', history: 'issued' },
  return: { status: 'returned', history: 'returned' },
  damaged: { status: 'damaged', history: 'damaged' },
  lost: { status: 'lost', history: 'lost' },
  repaired: { status: 'in_store', history: 'repaired' },
} as const;
type AssetAction = keyof typeof TRANSITIONS;

const HISTORY_SELECT = `
  SELECT h.*, e.full_name AS employee_name, e.employee_code
    FROM hr_asset_history h
    LEFT JOIN hr_employees e ON e.id = h.employee_id
   WHERE h.asset_id = ?
   ORDER BY h.at DESC, h.id DESC`;

const ASSET_SELECT = `
  SELECT a.*, e.full_name AS holder_name, e.employee_code AS holder_code
    FROM hr_assets a
    LEFT JOIN hr_employees e ON e.id = a.employee_id`;

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }
  try {
    const sp = new URL(request.url).searchParams;
    const db = getDb();

    // Single-asset read: the asset + its full movement ledger.
    const id = s(sp.get('id'));
    if (id) {
      const asset = db.prepare(`${ASSET_SELECT} WHERE a.id = ?`).get(id) as any;
      if (!asset) return Response.json({ error: 'Asset not found' }, { status: 404 });
      const history = db.prepare(HISTORY_SELECT).all(id) as any[];
      return Response.json({ asset, history });
    }

    // parseInt (not Number) so a float can't reach LIMIT/OFFSET and trip
    // SQLite's "datatype mismatch" 500 (the crm-calls convention).
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(sp.get('pageSize') || '25', 10) || 25));

    const clauses: string[] = [];
    const params: any[] = [];
    const q = s(sp.get('q'));
    if (q) {
      clauses.push('(a.name LIKE ? OR a.tag LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    const status = s(sp.get('status'));
    if (status) { clauses.push('a.status = ?'); params.push(status); }
    const kind = s(sp.get('kind'));
    if (kind) { clauses.push('a.kind = ?'); params.push(kind); }
    const employee_id = s(sp.get('employee_id'));
    if (employee_id) { clauses.push('a.employee_id = ?'); params.push(employee_id); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    // The SAME clause+params feed the page query and its COUNT(*), so total
    // and rows can never disagree.
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n FROM hr_assets a ${where}`)
      .get(...params) as { n: number };

    const rows = db
      .prepare(
        `${ASSET_SELECT} ${where}
         ORDER BY a.name COLLATE NOCASE, a.id
         LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as any[];

    return Response.json({ rows, total: totalRow.n, page, pageSize });
  } catch (e) {
    console.error('GET /api/hr/assets failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load assets' }, { status: 500 });
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

  const name = s(body?.name);
  if (!name) return Response.json({ error: 'Asset name is required' }, { status: 400 });

  // kind is '' (schema default) or a vocabulary key — a typo'd kind must not
  // create a row the list filters can never find.
  const kind = s(body?.kind);
  if (kind && !isHrAssetKind(kind)) {
    return Response.json({ error: 'Invalid asset kind' }, { status: 400 });
  }
  const tag = s(body?.tag);

  // better-sqlite3 is synchronous — resolve every await BEFORE touching the DB.
  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();

    // Duplicate tag guard (non-empty only — many assets legitimately carry no
    // tag). No UNIQUE constraint exists, so this pre-check is the guard.
    if (tag) {
      const dupe = db
        .prepare(`SELECT id FROM hr_assets WHERE tag = ? COLLATE NOCASE`)
        .get(tag) as any;
      if (dupe) {
        return Response.json({ error: 'An asset with that tag already exists' }, { status: 409 });
      }
    }

    const id = generateId();
    db.prepare(
      `INSERT INTO hr_assets (id, name, kind, tag, note) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, name, kind, tag, s(body?.note));

    const asset = db.prepare(`SELECT * FROM hr_assets WHERE id = ?`).get(id) as HrAsset;
    logAuditEvent(db, {
      event_type: 'hr.asset.create',
      entity_type: 'hr_asset',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      after: asset,
    });
    return Response.json({ asset });
  } catch (e) {
    console.error('POST /api/hr/assets failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to create asset' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const id = s(body?.id);
  if (!id) return Response.json({ error: 'Asset id is required' }, { status: 400 });

  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM hr_assets WHERE id = ?`).get(id) as HrAsset | undefined;
    if (!existing) return Response.json({ error: 'Asset not found' }, { status: 404 });

    const sets: string[] = [];
    const args: any[] = [];

    if (body.name !== undefined) {
      const name = s(body.name);
      if (!name) return Response.json({ error: 'Asset name cannot be empty' }, { status: 400 });
      sets.push('name = ?'); args.push(name);
    }
    if (body.kind !== undefined) {
      const kind = s(body.kind);
      if (kind && !isHrAssetKind(kind)) {
        return Response.json({ error: 'Invalid asset kind' }, { status: 400 });
      }
      sets.push('kind = ?'); args.push(kind);
    }
    if (body.tag !== undefined) {
      const tag = s(body.tag);
      if (tag) {
        const dupe = db
          .prepare(`SELECT id FROM hr_assets WHERE tag = ? COLLATE NOCASE AND id != ?`)
          .get(tag, id) as any;
        if (dupe) {
          return Response.json({ error: 'An asset with that tag already exists' }, { status: 409 });
        }
      }
      sets.push('tag = ?'); args.push(tag);
    }
    if (body.note !== undefined) {
      sets.push('note = ?'); args.push(s(body.note));
    }
    // status / employee_id are deliberately NOT updatable here — transitions
    // go through PATCH so the hr_asset_history ledger can never be skipped.
    if (!sets.length) return Response.json({ error: 'Nothing to update' }, { status: 400 });

    sets.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE hr_assets SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);

    const asset = db.prepare(`SELECT * FROM hr_assets WHERE id = ?`).get(id) as HrAsset;
    logAuditEvent(db, {
      event_type: 'hr.asset.update',
      entity_type: 'hr_asset',
      entity_id: id,
      actor_email: me.email,
      outlet_id: outletId,
      before: existing,
      after: asset,
    });
    return Response.json({ asset });
  } catch (e) {
    console.error('PUT /api/hr/assets failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update asset' }, { status: 500 });
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
  if (!id) return Response.json({ error: 'Asset id is required' }, { status: 400 });

  const action = s(body?.action) as AssetAction;
  if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, action)) {
    return Response.json(
      { error: 'Invalid action (expected issue, return, damaged, lost or repaired)' },
      { status: 400 },
    );
  }
  const bodyEmployeeId = s(body?.employee_id);
  const note = s(body?.note);

  // better-sqlite3 is synchronous — resolve every await BEFORE db.transaction.
  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM hr_assets WHERE id = ?`).get(id) as HrAsset | undefined;
    if (!existing) return Response.json({ error: 'Asset not found' }, { status: 404 });

    // Mapping contract: employee_id → hr_employees.id, validated whenever one
    // is supplied (issue REQUIRES it; the others may carry it for the ledger).
    if (action === 'issue' && !bodyEmployeeId) {
      return Response.json({ error: 'Issuing needs an employee' }, { status: 400 });
    }
    if (bodyEmployeeId) {
      const emp = db.prepare(`SELECT id FROM hr_employees WHERE id = ?`).get(bodyEmployeeId) as any;
      if (!emp) return Response.json({ error: 'Selected employee was not found' }, { status: 400 });
    }

    // Transition guards — mild, matching the physical flow.
    if (action === 'issue' && existing.status === 'issued') {
      return Response.json({ error: 'Asset is already issued — return it first' }, { status: 409 });
    }
    if (action === 'return' && existing.status !== 'issued') {
      return Response.json({ error: 'Asset is not currently issued' }, { status: 409 });
    }

    // New holder column: issue sets it; return + repaired put the asset back
    // in store (holder cleared); damaged/lost keep the holder accountable.
    const nextEmployeeId =
      action === 'issue' ? bodyEmployeeId :
      action === 'return' || action === 'repaired' ? '' :
      existing.employee_id;

    // Ledger row's employee: the person involved in THIS movement — the new
    // holder on issue, the previous holder on return, and the supplied (or
    // current) holder on damaged/lost/repaired.
    const historyEmployeeId =
      action === 'issue' ? bodyEmployeeId :
      action === 'return' ? existing.employee_id :
      bodyEmployeeId || existing.employee_id;

    const t = TRANSITIONS[action];
    const historyId = generateId();

    // Status transition + ledger append + audit in ONE transaction — the
    // ledger append ALWAYS happens with the transition, never separately.
    // Everything inside is synchronous.
    const apply = db.transaction(() => {
      db.prepare(
        `UPDATE hr_assets SET status = ?, employee_id = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(t.status, nextEmployeeId, id);
      db.prepare(
        `INSERT INTO hr_asset_history (id, asset_id, employee_id, action, note, acted_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(historyId, id, historyEmployeeId, t.history, note, me.email);
      logAuditEvent(db, {
        event_type: `hr.asset.${action}`,
        entity_type: 'hr_asset',
        entity_id: id,
        actor_email: me.email,
        outlet_id: outletId,
        before: existing,
        after: { ...existing, status: t.status, employee_id: nextEmployeeId },
        note,
      });
    });
    apply();

    const asset = db.prepare(`${ASSET_SELECT} WHERE a.id = ?`).get(id) as any;
    return Response.json({ asset });
  } catch (e) {
    console.error('PATCH /api/hr/assets failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to update the asset status' }, { status: 500 });
  }
}
