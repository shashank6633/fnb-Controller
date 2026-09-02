import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, canManageKitchenProduction } from '@/lib/auth';
import { listDepartmentOptions } from '@/lib/production-departments';

/**
 * The department list behind New Production Batch, and the Production Settings
 * screen that manages the extra lines on it.
 *
 *   GET  /api/kitchen-production/departments        → { groups, options, extras, can_manage }
 *   GET  /api/kitchen-production/departments?all=1  → also includes DEACTIVATED extras
 *   POST /api/kitchen-production/departments        → add an extra line { name }
 *   PUT  /api/kitchen-production/departments        → { id, name?, is_active? }
 *
 * ── THE GATE, AND WHY GET IS THE ODD ONE OUT ──────────────────────────────
 * WRITES use canManageKitchenProduction — `user.role === 'admin' || user.is_head_chef`,
 * answering 403 'Head chef or admin only'. That is byte-identical to every
 * neighbouring production write (batch create, items POST/PUT, dispose, print),
 * and deliberately NOT canApproveAsChef: the granular can_approve_requisitions
 * flag must not unlock production management.
 *
 * GET is open to ANY SIGNED-IN USER, following /scan and /take rather than the
 * HOD-gated module reads. Two reasons, and the first is the load-bearing one.
 * The owner has just removed `hodOnly` from /kitchen-production and
 * /kitchen-production/dashboard, so a head chef is no longer the only person who
 * reaches this screen — a staff-tier user standing in front of the New Batch
 * form needs to SEE the choices even where they cannot edit the list. Second,
 * this payload is a list of department NAMES: no quantity, no price, no stock,
 * nothing that isn't already on the requisition and department screens those
 * same users use daily. `can_manage` in the response is what the UI uses to
 * decide whether to render the write controls, so nobody is shown a button that
 * would 403 — the gate above stays the actual boundary either way.
 *
 * ── WHAT THIS ROUTE WILL NEVER DO ─────────────────────────────────────────
 * It never INSERTs, UPDATEs or DELETEs a `departments` row. "Add a new line in
 * the dropdown" writes to `production_departments`, a production-only label
 * list. A `departments` row is a requisition target and a stock-ledger holder;
 * minting one from a production screen would put a new receiver into Central
 * Store --issue--> Department Stock --recipe consumption--> consumed. Real
 * departments are created on /departments, and this route says so on screen.
 *
 * CSRF: covered by the '/api/kitchen-production' prefix in proxy.ts.
 */

/** Extras are never hard-deleted, so a batch that named one stays resolvable. */
const MAX_NAME = 60;

interface ExtraRow { id: string; name: string; is_active: number; sort_order: number }

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const db = getDb();
    const all = new URL(request.url).searchParams.get('all') === '1';
    const groups = listDepartmentOptions(db);
    const options = groups.flatMap((g) => g.options);

    // The Production Settings table needs the deactivated extras too, so an
    // admin can bring one back. The picker (all=0) must not see them.
    let extras: ExtraRow[] = [];
    try {
      extras = db.prepare(
        `SELECT id, name, is_active, sort_order FROM production_departments
          ${all ? '' : 'WHERE is_active = 1'}
          ORDER BY sort_order, name COLLATE NOCASE`,
      ).all() as ExtraRow[];
    } catch { extras = []; }

    return Response.json({ groups, options, extras, can_manage: canManageKitchenProduction(me) });
  } catch (e) {
    console.error('GET /api/kitchen-production/departments failed:', e);
    return Response.json({ error: e instanceof Error ? e.message : 'Failed to list departments' }, { status: 500 });
  }
}

/** Reject a name that already exists as EITHER an extra line or a real department. */
function nameConflict(db: ReturnType<typeof getDb>, name: string, ignoreId?: string): string | null {
  const dupExtra = db.prepare(
    `SELECT id FROM production_departments WHERE name = ? COLLATE NOCASE AND id != ?`,
  ).get(name, ignoreId || '') as { id: string } | undefined;
  if (dupExtra) return `"${name}" is already in the list.`;
  // A real department of the same name would render two identical-looking lines
  // in one dropdown, one of which moves material and one of which does not.
  const dupDept = db.prepare(
    `SELECT id FROM departments WHERE name = ? COLLATE NOCASE AND is_active = 1`,
  ).get(name) as { id: string } | undefined;
  if (dupDept) return `"${name}" is already a department — it is in the dropdown under its main department.`;
  return null;
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canManageKitchenProduction(me)) return Response.json({ error: 'Head chef, manager or admin only' }, { status: 403 });

    const body = await request.json().catch(() => ({}));
    const name = String(body?.name || '').trim();
    if (!name) return Response.json({ error: 'name is required' }, { status: 400 });
    if (name.length > MAX_NAME) return Response.json({ error: `name must be ${MAX_NAME} characters or fewer` }, { status: 400 });

    const db = getDb();
    const conflict = nameConflict(db, name);
    if (conflict) return Response.json({ error: conflict }, { status: 409 });

    const id = generateId();
    const next = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM production_departments`).get() as { n: number } | undefined;
    db.prepare(
      `INSERT INTO production_departments (id, name, sort_order) VALUES (?,?,?)`,
    ).run(id, name, Number(next?.n) || 0);

    const item = db.prepare(`SELECT id, name, is_active, sort_order FROM production_departments WHERE id = ?`).get(id);
    return Response.json({ item });
  } catch (e) {
    console.error('POST /api/kitchen-production/departments failed:', e);
    return Response.json({ error: e instanceof Error ? e.message : 'Failed to add department' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canManageKitchenProduction(me)) return Response.json({ error: 'Head chef, manager or admin only' }, { status: 403 });

    const body = await request.json().catch(() => ({}));
    const id = String(body?.id || '').trim();
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

    const db = getDb();
    const row = db.prepare(`SELECT * FROM production_departments WHERE id = ?`).get(id) as ExtraRow | undefined;
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 });

    const name = body?.name !== undefined ? String(body.name || '').trim() : row.name;
    if (!name) return Response.json({ error: 'name cannot be empty' }, { status: 400 });
    if (name.length > MAX_NAME) return Response.json({ error: `name must be ${MAX_NAME} characters or fewer` }, { status: 400 });
    if (name.toLowerCase() !== String(row.name).toLowerCase()) {
      const conflict = nameConflict(db, name, id);
      if (conflict) return Response.json({ error: conflict }, { status: 409 });
    }

    db.prepare(
      `UPDATE production_departments
          SET name = ?, is_active = ?, updated_at = datetime('now')
        WHERE id = ?`,
    ).run(name, body?.is_active !== undefined ? (body.is_active ? 1 : 0) : row.is_active, id);

    // A rename also refreshes the label SNAPSHOT on batches that named this
    // line. The snapshot is only a fallback (batchDepartmentMap resolves the
    // live name first), so this is cosmetic consistency — the same thing the
    // items route does to production_batches.item_name on a rename.
    //
    // ...and `kitchen_section` for the same batches, for the same reason. That
    // column is the DISPLAY half of the label+link pair: the two surfaces that
    // print a section straight from it — the Production CSV
    // (api/kitchen-production/reports) and /kitchen-production/scan — do not
    // join the link table, so without this line a rename showed the NEW name on
    // the batch list and drawer while the CSV and the scan screen kept printing
    // the OLD one. Verified: renaming an extra line left the CSV on the stale
    // name until this ran. Scoped to batches actually linked to THIS line, so a
    // batch that free-typed the same string years ago is not rewritten.
    //
    // Renaming a REAL department is out of this module's hands — that happens on
    // /departments, which does not know about kitchen_section, so those batches
    // keep their creation-time string in the CSV while the list and drawer show
    // the live department name.
    if (name !== row.name) {
      db.prepare(
        `UPDATE production_batch_departments SET label = ?, updated_at = datetime('now')
          WHERE production_department_id = ?`,
      ).run(name, id);
      db.prepare(
        `UPDATE production_batches SET kitchen_section = ?, updated_at = datetime('now')
          WHERE id IN (
            SELECT batch_id FROM production_batch_departments
             WHERE production_department_id = ?
          )`,
      ).run(name, id);
    }

    const item = db.prepare(`SELECT id, name, is_active, sort_order FROM production_departments WHERE id = ?`).get(id);
    return Response.json({ item });
  } catch (e) {
    console.error('PUT /api/kitchen-production/departments failed:', e);
    return Response.json({ error: e instanceof Error ? e.message : 'Failed to update department' }, { status: 500 });
  }
}
