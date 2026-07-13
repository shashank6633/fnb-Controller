import type { Database } from 'better-sqlite3';
import type { SessionUser } from './auth';
import { generateId } from './db';

/**
 * Multi-Store Inventory Engine — Phase A foundation (LIQUOR STORE first).
 *
 * Everything here is DYNAMIC config — no store name is hardcoded anywhere in
 * app logic. A store is a `store_locations` row; the categories it owns live
 * in `store_category_map`; per-user grants live in `store_user_access`; and
 * its stock is the SUM of signed `store_stock_ledger` quantities (recipe
 * units). Adding a Wine Cellar / Beer Store / Mini Bar later is pure data.
 *
 * Category matching is COLLATE NOCASE + TRIM everywhere (the column itself is
 * NOCASE; we still TRIM both sides so '  Rum ' matches 'rum').
 *
 * ⚠️ PHASE B GUARD (not yet enforced): store-mapped materials (liquor) must
 * never enter Central Store flows — purchases, GRN, requisition issue. Phase A
 * only ships the DETECTION helpers below (isStoreMappedMaterial /
 * storeGuardWarning). NO existing purchase/GRN/requisition flow changes
 * behaviour yet; Phase B wires the actual enforcement + warning banners using
 * these helpers. Do not "helpfully" call these from existing flows to block
 * anything before Phase B lands.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface StoreLocation {
  id: string;
  name: string;
  code: string;
  description: string;
  is_active: number;                 // 1 | 0
  requires_authorization: number;    // 1 = only granted users may see/use it
  created_at: string;
}

export interface StoreAccess {
  can_view: boolean;
  can_procure: boolean;
  can_adjust: boolean;
  can_close_stock: boolean;
}

export const NO_ACCESS: StoreAccess = Object.freeze({
  can_view: false, can_procure: false, can_adjust: false, can_close_stock: false,
});

export const FULL_ACCESS: StoreAccess = Object.freeze({
  can_view: true, can_procure: true, can_adjust: true, can_close_stock: true,
});

/** Allowed ledger transaction types (signed quantity, recipe units). */
export const LEDGER_TXN_TYPES = [
  'opening', 'purchase', 'inward', 'outward', 'adjustment', 'closing', 'transfer',
] as const;
export type LedgerTxnType = (typeof LEDGER_TXN_TYPES)[number];

export interface LedgerEntry {
  store_id: string;
  material_id: string;
  txn_type: LedgerTxnType;
  /** Signed, in RECIPE units (+ into the store / − out of the store). */
  quantity: number;
  /** ₹ per recipe unit at transaction time (0 = unknown → valuation falls back to rm.average_price). */
  unit_cost?: number;
  batch_no?: string;
  supplier?: string;
  vendor_id?: string;
  expiry_date?: string;
  ref?: string;
  notes?: string;
  created_by?: string;
}

export interface StoreStockRow {
  material_id: string;
  material_name: string;
  category: string;
  unit: string;
  /** SUM(ledger.quantity) — recipe units. */
  qty: number;
  /** Weighted avg unit_cost across positive-qty ledger rows, or rm.average_price fallback. */
  avg_cost: number;
  /** qty × avg_cost. */
  value: number;
}

// ── Store lookups ────────────────────────────────────────────────────────────

/** All store locations (active AND inactive — callers filter). */
export function listStores(db: Database): StoreLocation[] {
  return db.prepare(`
    SELECT id, name, code, description, is_active, requires_authorization, created_at
    FROM store_locations ORDER BY name COLLATE NOCASE
  `).all() as StoreLocation[];
}

export function getStoreById(db: Database, id: string): StoreLocation | null {
  const row = db.prepare(`
    SELECT id, name, code, description, is_active, requires_authorization, created_at
    FROM store_locations WHERE id = ?
  `).get(id) as StoreLocation | undefined;
  return row || null;
}

export function getStoreByName(db: Database, name: string): StoreLocation | null {
  const row = db.prepare(`
    SELECT id, name, code, description, is_active, requires_authorization, created_at
    FROM store_locations WHERE TRIM(name) = TRIM(?) COLLATE NOCASE
  `).get(String(name || '')) as StoreLocation | undefined;
  return row || null;
}

/** The category names mapped to a store (as stored — display them verbatim). */
export function storeCategories(db: Database, storeId: string): string[] {
  return (db.prepare(`
    SELECT category FROM store_category_map WHERE store_id = ? ORDER BY category COLLATE NOCASE
  `).all(storeId) as { category: string }[]).map(r => r.category);
}

/**
 * Which store (if any) owns a material, resolved from its category via
 * store_category_map (NOCASE + TRIM). Only ACTIVE stores claim materials — a
 * deactivated store releases its categories back to Central behaviour.
 * Returns the store_id or null (null = Central Store material).
 */
export function materialStoreId(
  db: Database,
  material: { category?: string | null } | null | undefined,
): string | null {
  const cat = String(material?.category || '').trim();
  if (!cat) return null;
  const row = db.prepare(`
    SELECT m.store_id
    FROM store_category_map m
    JOIN store_locations s ON s.id = m.store_id
    WHERE s.is_active = 1 AND TRIM(m.category) = TRIM(?) COLLATE NOCASE
    LIMIT 1
  `).get(cat) as { store_id: string } | undefined;
  return row?.store_id || null;
}

// ── Guard helpers (Phase B enforcement points — DETECTION ONLY in Phase A) ──

/**
 * Is this material owned by a store location (i.e. must it be kept OUT of
 * Central Store flows)? Accepts a raw_materials.id OR a category string —
 * ids are resolved to their category first; anything that isn't a known
 * material id is treated as a category name.
 *
 * Phase A: exported for Phase B to call from purchase/GRN/requisition flows.
 * NOTHING calls this from existing flows yet — zero behaviour change.
 */
export function isStoreMappedMaterial(db: Database, materialIdOrCategory: string): boolean {
  const key = String(materialIdOrCategory || '').trim();
  if (!key) return false;
  const mat = db.prepare('SELECT category FROM raw_materials WHERE id = ?').get(key) as { category: string } | undefined;
  const category = mat ? mat.category : key;
  return materialStoreId(db, { category }) != null;
}

/**
 * Soft-warning hook for Phase B UI banners: returns a human-readable warning
 * string when the material belongs to a store location, else null. Existing
 * purchase flows may render this as a non-blocking banner BEFORE Phase B turns
 * on hard enforcement. Phase A ships the hook only — no caller yet.
 */
export function storeGuardWarning(db: Database, materialIdOrCategory: string): string | null {
  const key = String(materialIdOrCategory || '').trim();
  if (!key) return null;
  const mat = db.prepare('SELECT name, category FROM raw_materials WHERE id = ?').get(key) as { name: string; category: string } | undefined;
  const category = mat ? mat.category : key;
  const storeId = materialStoreId(db, { category });
  if (!storeId) return null;
  const store = getStoreById(db, storeId);
  const label = mat ? `"${mat.name}"` : `Category "${category}"`;
  return `${label} belongs to ${store?.name || 'a store location'} — record its stock movements through that store, not the Central Store.`;
}

// ── Permissions ──────────────────────────────────────────────────────────────

/**
 * Resolve what a user may do in a given store:
 *   1. admin                              → everything
 *   2. is_head_chef / is_store_manager    → view + procure + adjust + close
 *      (spec: HOD, Bar Manager and Store Manager run liquor stock)
 *   3. position OR role name containing 'bar manager' (NOCASE) → same
 *   4. else the user's store_user_access row for this store
 *   5. else no access
 * Pure function over the session user + one small lookup — call it in every
 * store API route AND page loader so UI and API can never drift.
 */
export function userStoreAccess(
  db: Database,
  user: Pick<SessionUser, 'id' | 'role' | 'is_head_chef' | 'is_store_manager' | 'position' | 'role_name'> | null | undefined,
  storeId: string,
): StoreAccess {
  if (!user) return NO_ACCESS;
  if (user.role === 'admin') return FULL_ACCESS;
  if (user.is_head_chef || user.is_store_manager) return FULL_ACCESS;
  const posHit  = String(user.position  || '').toLowerCase().includes('bar manager');
  const roleHit = String(user.role_name || '').toLowerCase().includes('bar manager');
  if (posHit || roleHit) return FULL_ACCESS;
  const row = db.prepare(`
    SELECT can_view, can_procure, can_adjust, can_close_stock
    FROM store_user_access WHERE store_id = ? AND user_id = ?
  `).get(storeId, user.id) as { can_view: number; can_procure: number; can_adjust: number; can_close_stock: number } | undefined;
  if (!row) return NO_ACCESS;
  return {
    can_view: !!row.can_view,
    can_procure: !!row.can_procure,
    can_adjust: !!row.can_adjust,
    can_close_stock: !!row.can_close_stock,
  };
}

// ── Stock ────────────────────────────────────────────────────────────────────

/**
 * Current stock per material in a store: qty = SUM(signed ledger quantities),
 * avg cost = weighted average unit_cost over INFLOW rows that carried a cost
 * (falls back to raw_materials.average_price, which is already ₹/recipe-unit),
 * value = qty × avg cost. Materials whose ledger nets to exactly 0 AND have no
 * rows are naturally absent; net-zero materials with history are kept so a
 * fully-issued bottle count still shows on the page.
 */
export function storeStock(db: Database, storeId: string): StoreStockRow[] {
  const rows = db.prepare(`
    SELECT l.material_id,
           rm.name  AS material_name,
           rm.category,
           rm.unit,
           SUM(l.quantity) AS qty,
           SUM(CASE WHEN l.quantity > 0 AND l.unit_cost > 0 THEN l.quantity * l.unit_cost ELSE 0 END) AS in_value,
           SUM(CASE WHEN l.quantity > 0 AND l.unit_cost > 0 THEN l.quantity ELSE 0 END)               AS in_qty,
           rm.average_price
    FROM store_stock_ledger l
    JOIN raw_materials rm ON rm.id = l.material_id
    WHERE l.store_id = ?
    GROUP BY l.material_id
    ORDER BY rm.name COLLATE NOCASE
  `).all(storeId) as any[];
  return rows.map(r => {
    const avg = r.in_qty > 0 ? r.in_value / r.in_qty : (Number(r.average_price) || 0);
    const qty = Number(r.qty) || 0;
    return {
      material_id: r.material_id,
      material_name: r.material_name,
      category: r.category,
      unit: r.unit,
      qty,
      avg_cost: Math.round(avg * 10000) / 10000,
      value: Math.round(qty * avg * 100) / 100,
    };
  });
}

/**
 * Append one validated ledger row (the ONLY way store stock should ever move).
 * Throws Error with a user-presentable message on invalid input.
 * Returns the new ledger row id.
 */
export function postLedger(db: Database, entry: LedgerEntry): string {
  const storeId = String(entry.store_id || '').trim();
  const materialId = String(entry.material_id || '').trim();
  const txnType = String(entry.txn_type || '').trim() as LedgerTxnType;
  const qty = Number(entry.quantity);

  if (!storeId) throw new Error('store_id is required');
  if (!materialId) throw new Error('material_id is required');
  if (!LEDGER_TXN_TYPES.includes(txnType)) {
    throw new Error(`txn_type must be one of: ${LEDGER_TXN_TYPES.join(', ')}`);
  }
  if (!Number.isFinite(qty) || qty === 0) {
    throw new Error('quantity must be a non-zero number (signed, recipe units)');
  }
  const unitCost = Number(entry.unit_cost ?? 0);
  if (!Number.isFinite(unitCost) || unitCost < 0) throw new Error('unit_cost must be a number ≥ 0');

  const store = getStoreById(db, storeId);
  if (!store) throw new Error('Unknown store location');
  if (!store.is_active) throw new Error(`${store.name} is deactivated — reactivate it before posting stock`);
  const mat = db.prepare('SELECT id FROM raw_materials WHERE id = ?').get(materialId);
  if (!mat) throw new Error('Unknown material');

  const id = generateId();
  db.prepare(`
    INSERT INTO store_stock_ledger
      (id, store_id, material_id, txn_type, quantity, unit_cost,
       batch_no, supplier, vendor_id, expiry_date, ref, notes, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    id, storeId, materialId, txnType, qty, unitCost,
    String(entry.batch_no || ''), String(entry.supplier || ''), String(entry.vendor_id || ''),
    String(entry.expiry_date || ''), String(entry.ref || ''), String(entry.notes || ''),
    String(entry.created_by || ''),
  );
  return id;
}
