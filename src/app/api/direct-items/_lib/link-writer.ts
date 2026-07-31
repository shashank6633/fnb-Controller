/**
 * THE ONE WRITER for a direct-item ↔ raw-material mapping.
 *
 * `_lib` is a Next.js private folder (underscore prefix) — opted out of routing,
 * so this module is a plain implementation detail of /api/direct-items and never
 * becomes a URL.
 *
 * WHY IT EXISTS
 * ─────────────
 * Two callers now write this mapping:
 *   • POST /api/direct-items          — one row, edited on screen
 *   • POST /api/direct-items/import   — a whole CSV, applied in bulk
 *
 * A bulk importer with its own copy of the upsert is how single-item edits and
 * bulk edits drift: one of them forgets `reviewed = 1`, or updates
 * direct_item_links without the matching menu_items sweep, and the same mapping
 * then means two different things depending on which screen touched it last.
 * So there is exactly one function and both callers go through it.
 *
 * TWO TABLES, ONE MAPPING — both writes are load-bearing:
 *   1. direct_item_links — keyed on item_name (PRIMARY KEY … COLLATE NOCASE, so
 *      the upsert is case-insensitive by schema). Works for ANY sold item name,
 *      including POS variants and typos that have no menu_items row at all.
 *   2. menu_items.material_id — every menu row sharing that name, so the rest of
 *      the app (costing, consumption) sees the link too.
 *
 * NOT transactional on its own: the caller wraps it, because the bulk importer
 * must apply an entire CSV in ONE transaction (all-or-nothing), and nesting a
 * better-sqlite3 transaction inside another is a savepoint, not what we want.
 */
import type { Database } from 'better-sqlite3';

export interface DirectLinkWrite {
  /** The sold item name. Matched case-insensitively (schema COLLATE NOCASE). */
  item_name: string;
  /** Raw material id, or null to unlink. */
  material_id: string | null;
  /** Raw-material units consumed per one sold unit. */
  qty_per_unit: number;
  /** Hide the row from the Direct Items report (sales history untouched). */
  dismissed: boolean;
}

/** Normalise a qty_per_unit from any input shape. Invalid / ≤ 0 → 1. */
export function normalizeQtyPerUnit(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Apply one mapping. Returns the number of menu_items rows updated.
 * Caller supplies the transaction.
 */
export function writeDirectItemLink(db: Database, w: DirectLinkWrite): number {
  const qpu = normalizeQtyPerUnit(w.qty_per_unit);
  const dismissedFlag = w.dismissed ? 1 : 0;

  // 1. Upsert into direct_item_links — works for any sold item name, even if no
  //    matching menu_items row exists (e.g. POS variants, typos, direct-only items).
  db.prepare(`
    INSERT INTO direct_item_links (item_name, material_id, qty_per_unit, dismissed, reviewed, updated_at)
    VALUES (?, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(item_name) DO UPDATE SET
      material_id  = excluded.material_id,
      qty_per_unit = excluded.qty_per_unit,
      dismissed    = excluded.dismissed,
      reviewed     = 1,
      updated_at   = datetime('now')
  `).run(w.item_name, w.material_id || null, qpu, dismissedFlag);

  // 2. Also update menu_items where the name exists — so every menu item with this
  //    name (including variants that share a name) gets linked too.
  const r = db.prepare(`
    UPDATE menu_items
    SET material_id = ?, direct_reviewed = 1, updated_at = datetime('now')
    WHERE LOWER(name) = LOWER(?)
  `).run(w.material_id || null, w.item_name);
  return r.changes;
}
