/**
 * Variance approval workflow.
 *
 * A closing physical count that disagrees with the system NEVER changes stock on
 * its own. Instead it creates a PENDING `variance_approvals` row. An admin then
 * reviews it (records the staff's reason) and either:
 *   - APPROVES  → stock is moved to the counted (physical) number, and the
 *                 adjustment is logged (central: inventory_transactions;
 *                 liquor: a store_stock_ledger 'adjustment' movement).
 *   - REJECTS   → stock is left untouched; the variance stands as an open loss
 *                 to investigate (theft / spillage / miscount).
 *
 * Covers both CENTRAL raw-material counts (source='central', keyed by department)
 * and LIQUOR/floor-bar counts (source='liquor', keyed by store).
 */
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
import { postLedger } from '@/lib/store-engine';

export type VarianceSource = 'central' | 'liquor';

export interface CreateVarianceInput {
  source: VarianceSource;
  material_id: string;
  store_id?: string;         // liquor only
  department_id?: string;    // central only ('' = Store/Overall)
  date: string;
  system_stock: number;
  physical_stock: number;
  unit?: string;
  counted_by?: string;
  count_note?: string;
  outlet_id?: string | null;
}

const norm = (v?: string | null): string => (v == null ? '' : String(v).trim());

/**
 * Create or refresh a PENDING variance approval. Idempotent per
 * (source, material, store, dept, date): re-counting the same item before it is
 * approved updates the SAME pending row instead of stacking duplicates. A zero
 * variance is a no-op (nothing to approve) and returns null.
 */
export function upsertVarianceApproval(db: Database.Database, inp: CreateVarianceInput): string | null {
  const variance = Math.round((Number(inp.physical_stock) - Number(inp.system_stock)) * 1000) / 1000;
  const storeId = norm(inp.store_id);
  const deptId = norm(inp.department_id);
  const outletId = norm(inp.outlet_id);

  // A corrected re-count that now matches the system clears any stale PENDING
  // approval for this key (nothing left to approve). Already-decided rows stay.
  if (variance === 0) {
    db.prepare(`
      DELETE FROM variance_approvals
      WHERE status = 'pending' AND source = ? AND material_id = ? AND store_id = ? AND department_id = ? AND date = ? AND outlet_id = ?
    `).run(inp.source, inp.material_id, storeId, deptId, inp.date, outletId);
    return null;
  }

  const mat = db.prepare('SELECT average_price FROM raw_materials WHERE id = ?').get(inp.material_id) as
    { average_price: number } | undefined;
  const avg = Number(mat?.average_price) || 0;
  const varianceValue = Math.round(variance * avg * 100) / 100;

  const existing = db.prepare(`
    SELECT id FROM variance_approvals
    WHERE status = 'pending' AND source = ? AND material_id = ? AND store_id = ? AND department_id = ? AND date = ? AND outlet_id = ?
  `).get(inp.source, inp.material_id, storeId, deptId, inp.date, outletId) as { id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE variance_approvals SET
        system_stock = ?, physical_stock = ?, variance = ?, variance_value = ?, unit = ?,
        counted_by = ?, count_note = ?, created_at = datetime('now')
      WHERE id = ?
    `).run(
      inp.system_stock, inp.physical_stock, variance, varianceValue, norm(inp.unit),
      norm(inp.counted_by), norm(inp.count_note), existing.id,
    );
    return existing.id;
  }

  const id = generateId();
  db.prepare(`
    INSERT INTO variance_approvals
      (id, source, material_id, store_id, department_id, date, system_stock, physical_stock,
       variance, variance_value, unit, counted_by, count_note, status, outlet_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, datetime('now'))
  `).run(
    id, inp.source, inp.material_id, storeId, deptId, inp.date, inp.system_stock, inp.physical_stock,
    variance, varianceValue, norm(inp.unit), norm(inp.counted_by), norm(inp.count_note), outletId,
  );
  return id;
}

/** Count of pending approvals (optionally scoped to one outlet). */
export function pendingVarianceCount(db: Database.Database, outletId?: string | null): number {
  const oid = norm(outletId);
  const row = oid
    ? db.prepare(`SELECT COUNT(*) AS n FROM variance_approvals WHERE status='pending' AND (outlet_id = ? OR outlet_id = '')`).get(oid) as { n: number }
    : db.prepare(`SELECT COUNT(*) AS n FROM variance_approvals WHERE status='pending'`).get() as { n: number };
  return row?.n || 0;
}

export interface VarianceRow {
  id: string; source: VarianceSource; material_id: string; material_name: string; material_sku: string;
  store_id: string; store_name: string; department_id: string; department_name: string;
  date: string; system_stock: number; physical_stock: number; variance: number; variance_value: number;
  unit: string; counted_by: string; count_note: string;
  status: string; reviewed_by: string; reviewed_at: string; review_reason: string; created_at: string;
}

/** List approvals (default: pending first, newest first). */
export function listVarianceApprovals(
  db: Database.Database,
  opts: { status?: string; outletId?: string | null; limit?: number } = {},
): VarianceRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status && opts.status !== 'all') { where.push('va.status = ?'); params.push(opts.status); }
  const oid = norm(opts.outletId);
  if (oid) { where.push("(va.outlet_id = ? OR va.outlet_id = '')"); params.push(oid); }
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 1000);
  const rows = db.prepare(`
    SELECT va.*, rm.name AS material_name, rm.sku AS material_sku,
           COALESCE(sl.name, '')  AS store_name,
           COALESCE(d.name, '')   AS department_name
    FROM variance_approvals va
    JOIN raw_materials rm ON rm.id = va.material_id
    LEFT JOIN store_locations sl ON sl.id = va.store_id
    LEFT JOIN departments d ON d.id = va.department_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY (va.status = 'pending') DESC, va.date DESC, va.created_at DESC
    LIMIT ${limit}
  `).all(...params) as VarianceRow[];
  return rows;
}

export interface DecisionResult { ok: boolean; error?: string; applied?: boolean }

/**
 * Approve a pending variance → move stock to the physical count and log it.
 * `reason` is the explanation the admin recorded after asking the staff.
 */
export function approveVariance(
  db: Database.Database, id: string, reviewer: string, reason: string,
): DecisionResult {
  const row = db.prepare(`SELECT * FROM variance_approvals WHERE id = ?`).get(id) as (VarianceRow & Record<string, unknown>) | undefined;
  if (!row) return { ok: false, error: 'Variance approval not found' };
  if (row.status !== 'pending') return { ok: false, error: `Already ${row.status}` };

  const apply = db.transaction(() => {
    if (row.source === 'liquor') {
      // Reconcile the store ledger to the physical count as of the count date.
      postLedger(db, {
        store_id: row.store_id,
        material_id: row.material_id,
        txn_type: 'adjustment',
        quantity: row.variance,        // signed (physical − system), recipe units
        unit_cost: 0,
        ref: `variance-approval:${row.date}`,
        notes: `Approved variance ${row.date}: system ${row.system_stock} → physical ${row.physical_stock} ${row.unit}`,
        created_by: reviewer,
      });
    } else {
      // Central raw material: set live stock to the counted number. Log the ACTUAL
      // delta (current → physical), which may differ from the count-time variance
      // if stock moved between the count and this (deferred) approval — so the
      // ledger movement always matches the change actually applied.
      const cur = db.prepare(`SELECT current_stock FROM raw_materials WHERE id = ?`).get(row.material_id) as { current_stock: number } | undefined;
      const before = Number(cur?.current_stock) || 0;
      const appliedDelta = Math.round((row.physical_stock - before) * 1000) / 1000;
      db.prepare(`UPDATE raw_materials SET current_stock = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(row.physical_stock, row.material_id);
      if (appliedDelta !== 0) {
        db.prepare(`
          INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
          VALUES (?, ?, 'adjustment', ?, ?, ?, datetime('now'))
        `).run(
          generateId(), row.material_id, appliedDelta, id,
          `Approved variance ${row.date}: counted ${row.physical_stock} ${row.unit} (was ${before}; count-time system ${row.system_stock})`,
        );
      }
    }
    db.prepare(`
      UPDATE variance_approvals SET status='approved', reviewed_by=?, reviewed_at=datetime('now'), review_reason=? WHERE id=?
    `).run(norm(reviewer), norm(reason), id);
  });

  try { apply(); } catch (e) { return { ok: false, error: (e as Error).message }; }
  return { ok: true, applied: true };
}

/** Reject a pending variance → stock unchanged; variance stands as an open loss. */
export function rejectVariance(
  db: Database.Database, id: string, reviewer: string, reason: string,
): DecisionResult {
  const row = db.prepare(`SELECT status FROM variance_approvals WHERE id = ?`).get(id) as { status: string } | undefined;
  if (!row) return { ok: false, error: 'Variance approval not found' };
  if (row.status !== 'pending') return { ok: false, error: `Already ${row.status}` };
  db.prepare(`
    UPDATE variance_approvals SET status='rejected', reviewed_by=?, reviewed_at=datetime('now'), review_reason=? WHERE id=?
  `).run(norm(reviewer), norm(reason), id);
  return { ok: true, applied: false };
}
