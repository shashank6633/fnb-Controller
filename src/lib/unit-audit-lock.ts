/**
 * Unit-audit lock helpers.
 *
 * A "lock" is the admin-curated snapshot of unit-of-measure fields for a single
 * raw_material. Once a material has been reviewed on the /unit-audit page, its
 * units, pack/case sizes and category are persisted in `unit_audit_locks` and
 * become the source of truth — protected from purchase imports, recoverable
 * after a full data wipe, and exportable as CSV for offline editing.
 *
 * Match priority: SKU (exact) → name_key (lower-cased trimmed name).
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export type UnitAuditLockRow = {
  sku?: string | null;
  name: string;
  recipe_unit?: string | null;
  purchase_unit?: string | null;
  pack_size?: number | null;
  case_size?: number | null;
  category?: string | null;
};

export function nameKey(name: string): string {
  return String(name || '').toLowerCase().trim();
}

/** Upsert a lock row. Called every time PUT /api/unit-audit saves changes. */
export function upsertUnitLock(db: Database.Database, row: UnitAuditLockRow, lockedBy?: string) {
  const sku = row.sku ? String(row.sku).trim() : null;
  const nk = nameKey(row.name);
  if (!nk) return;
  // Look up by SKU first, then name_key.
  let existing: any = null;
  if (sku) existing = db.prepare('SELECT * FROM unit_audit_locks WHERE sku = ?').get(sku);
  if (!existing) existing = db.prepare('SELECT * FROM unit_audit_locks WHERE name_key = ?').get(nk);

  const recipeUnit   = row.recipe_unit   ?? existing?.recipe_unit   ?? null;
  const purchaseUnit = row.purchase_unit ?? existing?.purchase_unit ?? null;
  const packSize     = row.pack_size     ?? existing?.pack_size     ?? null;
  const caseSize     = row.case_size     ?? existing?.case_size     ?? null;
  const category     = row.category      ?? existing?.category      ?? null;

  if (existing) {
    db.prepare(`
      UPDATE unit_audit_locks SET
        sku = COALESCE(?, sku),
        name_key = ?, name = ?,
        recipe_unit = ?, purchase_unit = ?, pack_size = ?, case_size = ?, category = ?,
        locked_by = COALESCE(?, locked_by),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(sku, nk, row.name, recipeUnit, purchaseUnit, packSize, caseSize, category,
           lockedBy || null, existing.id);
  } else {
    db.prepare(`
      INSERT INTO unit_audit_locks
        (id, sku, name_key, name, recipe_unit, purchase_unit, pack_size, case_size, category, locked_by, locked_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(randomUUID(), sku, nk, row.name, recipeUnit, purchaseUnit, packSize, caseSize, category, lockedBy || null);
  }
}

/** Find an existing lock for a material (SKU → name fallback). */
export function findUnitLock(db: Database.Database, opts: { sku?: string | null; name?: string | null }) {
  const sku = opts.sku ? String(opts.sku).trim() : null;
  const nk = nameKey(opts.name || '');
  if (sku) {
    const r = db.prepare('SELECT * FROM unit_audit_locks WHERE sku = ?').get(sku) as any;
    if (r) return r;
  }
  if (nk) {
    return db.prepare('SELECT * FROM unit_audit_locks WHERE name_key = ?').get(nk) as any;
  }
  return null;
}
