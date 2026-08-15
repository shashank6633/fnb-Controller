import type Database from 'better-sqlite3';
// THE definition of the figure lives in dept-stock.ts, beside the department
// arithmetic it is built from, and is imported here rather than restated. If
// this file computed "in-hand stock" its own way there would be two definitions
// — the one the picker shows while you order and the one the audit column shows
// afterwards — and they would be free to drift. /api/stock-on-hand (the live
// picker feed) and this writer call the SAME function, which is what makes the
// snapshot and the picker structurally incapable of disagreeing.
import { stockOnHandBulk } from './dept-stock';
import type { StockOnHand, StockLeg } from './dept-stock';

/**
 * PO line stock snapshot — the frozen copy of "what was in hand the moment this
 * line was raised".
 *
 * WRITE-ONCE, and that is a structural guarantee, not a convention:
 * `snapshotPoLines` is the ONLY writer in the codebase and it inserts
 * `ON CONFLICT (po_id, material_id) DO NOTHING`. Nothing may ever UPDATE
 * `po_line_stock_snapshots` — not edit, not submit, not approve, not receive,
 * not GRN, not a price correction, not a pack correction, not an outlet change.
 * The only legal deletion is the `ON DELETE CASCADE` when the parent PO is
 * deleted. A reviewer seeing an UPDATE against this table must reject it.
 *
 * NO ZERO-FILL, ANYWHERE ON THIS PATH. A material with no readable figure gets
 * NO ROW, and the reader renders "not recorded". A stored `0` therefore always
 * means a measured zero. This is why nothing here coalesces: `dept_counted_qty`
 * stays NULL when no department in scope has an anchored count, and a material
 * absent from `stockOnHandBulk`'s Map is skipped rather than written as zeros.
 *
 * UNITS: every `*_qty` column is in RECIPE units — the basis
 * `raw_materials.current_stock` and the department ledger are stored in — and
 * `basis` records that on every row. The pack meta (`unit`, `purchase_unit`,
 * `pack_size`, `case_size`) is frozen alongside so that a later pack correction
 * cannot restate a historical quantity when it is rendered in purchase units.
 * Nothing in this file divides or multiplies by `pack_size`: conversion for
 * display is `toPurchaseQty()`'s job, at the point of render.
 */

/** How a snapshot row came to exist. Recorded verbatim in `source`. */
export type SnapshotSource =
  /* THE ONE THE FEATURE IS ABOUT. The owner asked for stock as it stood when
   * the PO was APPROVED, and approval is the single chokepoint every PO passes
   * through whatever route composed its lines — so this covers Smart Reorder
   * and the requisition auto-PO too, which the create-time hook never could. */
  | 'po_approve'
  /* Retained for rows already written by the create-time hook while that was
   * the model, and for lines added to an already-approved PO, which are
   * snapshotted at the moment they are added because approval has passed. */
  | 'po_create'
  | 'po_edit_add'
  | 'po_edit_approved_add'
  | 'smart_reorder';

/** One stored snapshot row, decoded. Quantities are RECIPE units. */
export interface PoLineSnapshot {
  po_id: string;
  material_id: string;
  taken_at: string;
  taken_by: string;
  source: string;
  /** Always 'recipe' for rows this writer produces. Read it, never assume it. */
  basis: string;

  // Pack meta AS IT WAS when the figure was taken — feed to toPurchaseQty().
  unit: string;
  purchase_unit: string;
  pack_size: number;
  case_size: number;

  // ── STORES RAIL ──
  central_qty: number;
  stores: StockLeg[];
  store_total_qty: number;
  store_mapped: boolean;

  // ── DEPARTMENTS RAIL ──
  depts: StockLeg[];
  /** NULL means no department in scope had an anchored count. NEVER read as 0. */
  dept_counted_qty: number | null;
  dept_counted_count: number;
  dept_uncounted_count: number;
}

export interface SnapshotOptions {
  /** Who raised the line. Stored as-is; '' is acceptable for machine paths. */
  takenBy: string;
  source: SnapshotSource;
  /**
   * The figure, taken OUTSIDE the caller's `db.transaction(...)`.
   *
   * better-sqlite3 is synchronous, so every millisecond spent computing inside a
   * transaction is a millisecond the whole app — billing included — waits on the
   * SQLite write lock, and the department half of this figure is the expensive
   * part. Callers therefore compute microseconds before opening the txn (still
   * honestly "when the PO was raised") and hand the result in here.
   *
   * Optional, and safe to omit: this function then takes the same figure itself,
   * using the same function, inside the lock instead of before it. Materials
   * missing from a supplied Map are topped up in one extra batched call, so a
   * partial Map can never silently produce a wrong number or a skipped line.
   */
  precomputed?: Map<string, StockOnHand>;
}

/** The key `readPoSnapshots` returns its Map under. */
export function snapshotKey(poId: string, materialId: string): string {
  return `${poId}::${materialId}`;
}

/**
 * THE ONLY WRITER. Inserts one row per distinct material currently on the PO.
 *
 * Call it INSIDE the same `db.transaction(...)` as the lines it describes, right
 * after the line INSERT loop, so the snapshot and the lines commit together or
 * not at all — a `purchase_order_items` row must never exist without the stock
 * figure that was true when it was raised.
 *
 * Reads the material list from `purchase_order_items` rather than from the
 * caller's payload on purpose: that is the set of lines that actually landed,
 * after whatever filtering, merging or store-blocking the route applied. It is
 * also what makes the function correct on the DELETE-then-re-INSERT edit paths.
 *
 * Idempotent by construction. On an edit, materials already on the PO keep their
 * ORIGINAL `taken_at` and figures (DO NOTHING); only materials new to the PO get
 * a row, taken at that moment. A line removed from a draft and re-added later
 * keeps its first snapshot — the PO was raised at T, and every row carries its
 * own `taken_at`, so nothing is hidden.
 *
 * @returns how many rows were actually inserted (0 when every line already had
 *          one, which is the normal result of a rate-only edit).
 */
export function snapshotPoLines(
  db: Database.Database,
  poId: string,
  opts: SnapshotOptions,
): number {
  const id = String(poId || '').trim();
  if (!id) return 0;

  // DISTINCT: one material = one line is enforced upstream (duplicateLineError
  // on the human paths, mergeDuplicateLines on the machine ones), but the table
  // is keyed on (po_id, material_id) and this writer must not depend on that
  // enforcement holding to avoid an avoidable conflict.
  const rows = db
    .prepare(
      `SELECT DISTINCT material_id
         FROM purchase_order_items
        WHERE po_id = ? AND TRIM(COALESCE(material_id, '')) <> ''`,
    )
    .all(id) as Array<{ material_id: string }>;

  const materialIds = [...new Set(rows.map((r) => String(r.material_id).trim()).filter(Boolean))];
  if (materialIds.length === 0) return 0;

  // Use what the caller measured outside the lock; compute only what is missing.
  // A material absent from BOTH is one `stockOnHandBulk` could not describe (it
  // is not in raw_materials) — it is skipped below, never written as zeros.
  const figures: Map<string, StockOnHand> = opts.precomputed
    ? new Map(opts.precomputed)
    : new Map();
  const missing = materialIds.filter((m) => !figures.has(m));
  if (missing.length > 0) {
    for (const [k, v] of stockOnHandBulk(db, missing)) figures.set(k, v);
  }

  const ins = db.prepare(`
    INSERT INTO po_line_stock_snapshots
      (po_id, material_id, taken_at, taken_by, source, basis,
       unit, purchase_unit, pack_size, case_size,
       central_qty, stores_json, store_total_qty, store_mapped,
       dept_json, dept_counted_qty, dept_counted_count, dept_uncounted_count)
    VALUES
      (?, ?, datetime('now'), ?, ?, 'recipe',
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?)
    ON CONFLICT (po_id, material_id) DO NOTHING
  `);

  const takenBy = String(opts.takenBy || '');
  let written = 0;
  for (const materialId of materialIds) {
    const f = figures.get(materialId);
    // NOT RECORDED beats a confident zero: no figure, no row.
    if (!f) continue;
    const res = ins.run(
      id,
      materialId,
      takenBy,
      opts.source,
      f.unit,
      f.purchase_unit,
      f.pack_size,
      f.case_size,
      f.central_qty,
      JSON.stringify(f.stores ?? []),
      f.store_total_qty,
      f.store_mapped ? 1 : 0,
      JSON.stringify(f.depts ?? []),
      // NULL survives as NULL. Do not coalesce it to 0 — "no department has an
      // anchored count" and "every department counted zero" are different facts.
      f.dept_counted_qty === null || f.dept_counted_qty === undefined ? null : f.dept_counted_qty,
      f.dept_counted_count,
      f.dept_uncounted_count,
    );
    written += res.changes;
  }
  return written;
}

/**
 * READ-ONLY. Batched reader for the Purchases column.
 *
 * A requested key that has no stored row is simply ABSENT from the returned Map.
 * Callers MUST render that as "not recorded" — never 0. Most rows in `purchases`
 * have no PO at all, and every PO raised before this feature shipped has no
 * snapshot; both are legitimately unknown.
 */
export function readPoSnapshots(
  db: Database.Database,
  keys: Array<{ po_id: string; material_id: string }>,
): Map<string, PoLineSnapshot> {
  const out = new Map<string, PoLineSnapshot>();
  if (!Array.isArray(keys) || keys.length === 0) return out;

  // Deduped and fetched by po_id, then filtered to the exact pairs asked for.
  // One query regardless of how many keys, and no SQL built by string
  // concatenation from caller data.
  const wanted = new Set<string>();
  const poIds = new Set<string>();
  for (const k of keys) {
    const p = String(k?.po_id ?? '').trim();
    const m = String(k?.material_id ?? '').trim();
    if (!p || !m) continue;
    wanted.add(snapshotKey(p, m));
    poIds.add(p);
  }
  if (wanted.size === 0) return out;

  const rows = db
    .prepare(
      `SELECT * FROM po_line_stock_snapshots
        WHERE po_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify([...poIds])) as Array<Record<string, unknown>>;

  for (const r of rows) {
    const poId = String(r.po_id);
    const materialId = String(r.material_id);
    const key = snapshotKey(poId, materialId);
    if (!wanted.has(key)) continue;
    out.set(key, {
      po_id: poId,
      material_id: materialId,
      taken_at: String(r.taken_at ?? ''),
      taken_by: String(r.taken_by ?? ''),
      source: String(r.source ?? ''),
      basis: String(r.basis ?? 'recipe'),
      unit: String(r.unit ?? ''),
      purchase_unit: String(r.purchase_unit ?? ''),
      pack_size: Number(r.pack_size) || 1,
      case_size: Number(r.case_size) || 1,
      central_qty: Number(r.central_qty),
      stores: parseLegs(r.stores_json),
      store_total_qty: Number(r.store_total_qty),
      store_mapped: !!Number(r.store_mapped),
      depts: parseLegs(r.dept_json),
      // The one column that is genuinely nullable, and the one place a `|| 0`
      // would turn "not counted" into a counted zero.
      dept_counted_qty: r.dept_counted_qty === null || r.dept_counted_qty === undefined
        ? null
        : Number(r.dept_counted_qty),
      dept_counted_count: Number(r.dept_counted_count) || 0,
      dept_uncounted_count: Number(r.dept_uncounted_count) || 0,
    });
  }
  return out;
}

/** Defensive JSON decode: a malformed blob yields no legs, never a throw that
 *  would take down a page listing 2,000 purchases over one bad row. The totals
 *  are stored in their own columns, so a lost leg list degrades the breakdown,
 *  not the figure. */
function parseLegs(raw: unknown): StockLeg[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as StockLeg[]) : [];
  } catch {
    return [];
  }
}
