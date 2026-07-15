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
 * Phase B HARD guard: returns the blocking error message when a material must
 * NOT enter Central Store flows (purchases / GRN / PO / inward import), else
 * null (= Central material, proceed). Accepts a raw_materials.id OR a raw
 * category string, like isStoreMappedMaterial.
 *
 * Wired into: /api/purchases POST, /api/grn POST (per-line skip+report),
 * /api/purchase-orders POST+PUT (draft compose), /api/purchase-orders/[id]/
 * receive (per-line skip+report, so HISTORICAL liquor POs never pollute
 * central stock), /api/inward-import/commit (per-row skip+report).
 * Store procurement lives ONLY in store_stock_ledger via /api/stores/[id]/
 * procure — central purchases / average_price / current_stock stay untouched.
 */
export function centralFlowBlock(db: Database, materialIdOrCategory: string): string | null {
  const key = String(materialIdOrCategory || '').trim();
  if (!key) return null;
  const mat = db.prepare('SELECT name, category FROM raw_materials WHERE id = ?').get(key) as { name: string; category: string } | undefined;
  const category = mat ? mat.category : key;
  const storeId = materialStoreId(db, { category });
  if (!storeId) return null;
  const store = getStoreById(db, storeId);
  const label = mat ? `"${mat.name}"` : `Category "${category}"`;
  return `${label} is a ${store?.name || 'store location'} material — use Inventory → Liquor Store → New Purchase. Store-mapped materials never enter Central Store purchases.`;
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

// ── Consolidated board + per-store item lists (Multi-floor bar, Phase 1) ──────

/** One row of the admin consolidated stock board: a material's qty in every
 *  active store plus the grand total (qty + valuation). */
export interface ConsolidatedStockRow {
  material_id: string;
  name: string;
  category: string;
  unit: string;
  pack_size: number;
  case_size: number;
  /** store_id → qty (recipe units). Every ACTIVE store has an entry (0 if none). */
  by_store: Record<string, number>;
  /** Σ by_store qty (recipe units). */
  total_qty: number;
  /** Σ per-store (qty × that store's weighted-avg ₹/recipe-unit), 2dp. */
  total_value: number;
}

/**
 * Per-material stock across EVERY active store (Liquor Store + all floors).
 * Material universe = union of (category-mapped materials of any active store)
 * and (materials with any ledger row in any active store) — so a receiving
 * floor's holdings appear even though floors own no categories. Each row's
 * by_store carries an entry for every active store (0 where empty) so the board
 * renders stable columns. Valuation uses each store's OWN weighted-avg cost
 * (falls back to raw_materials.average_price), matching storeStock().
 */
export function consolidatedStock(db: Database): ConsolidatedStockRow[] {
  const stores = listStores(db).filter(s => !!s.is_active);
  const activeIds = stores.map(s => s.id);
  if (activeIds.length === 0) return [];
  const ph = activeIds.map(() => '?').join(',');

  // Per (store, material) ledger aggregate over active stores.
  const ledgerRows = db.prepare(`
    SELECT l.store_id, l.material_id,
           SUM(l.quantity) AS qty,
           SUM(CASE WHEN l.quantity > 0 AND l.unit_cost > 0 THEN l.quantity * l.unit_cost ELSE 0 END) AS in_value,
           SUM(CASE WHEN l.quantity > 0 AND l.unit_cost > 0 THEN l.quantity ELSE 0 END)               AS in_qty
    FROM store_stock_ledger l
    WHERE l.store_id IN (${ph})
    GROUP BY l.store_id, l.material_id
  `).all(...activeIds) as { store_id: string; material_id: string; qty: number; in_value: number; in_qty: number }[];

  // Materials owned (category-mapped) by any active store.
  const mappedRows = db.prepare(`
    SELECT DISTINCT rm.id AS material_id
    FROM raw_materials rm
    JOIN store_category_map m ON TRIM(m.category) = TRIM(rm.category) COLLATE NOCASE
    WHERE m.store_id IN (${ph})
  `).all(...activeIds) as { material_id: string }[];

  const matIds = new Set<string>();
  for (const r of ledgerRows) matIds.add(r.material_id);
  for (const r of mappedRows) matIds.add(r.material_id);
  if (matIds.size === 0) return [];

  // agg[material_id][store_id] = {qty,in_value,in_qty}
  const agg = new Map<string, Map<string, { qty: number; in_value: number; in_qty: number }>>();
  for (const r of ledgerRows) {
    let byStore = agg.get(r.material_id);
    if (!byStore) { byStore = new Map(); agg.set(r.material_id, byStore); }
    byStore.set(r.store_id, { qty: Number(r.qty) || 0, in_value: Number(r.in_value) || 0, in_qty: Number(r.in_qty) || 0 });
  }

  // Material meta.
  const idList = [...matIds];
  const metaPh = idList.map(() => '?').join(',');
  const metaRows = db.prepare(`
    SELECT id AS material_id, name, category, unit,
           COALESCE(pack_size, 1) AS pack_size, COALESCE(case_size, 1) AS case_size,
           COALESCE(average_price, 0) AS average_price
    FROM raw_materials WHERE id IN (${metaPh})
  `).all(...idList) as any[];

  const out: ConsolidatedStockRow[] = metaRows.map(m => {
    const byStore: Record<string, number> = {};
    let totalQty = 0;
    let totalValue = 0;
    const perStore = agg.get(m.material_id);
    for (const sid of activeIds) {
      const a = perStore?.get(sid);
      const qty = a ? a.qty : 0;
      const avg = a && a.in_qty > 0 ? a.in_value / a.in_qty : (Number(m.average_price) || 0);
      byStore[sid] = Math.round(qty * 10000) / 10000;
      totalQty += qty;
      totalValue += qty * avg;
    }
    return {
      material_id: m.material_id,
      name: m.name,
      category: m.category,
      unit: m.unit,
      pack_size: Number(m.pack_size) || 1,
      case_size: Number(m.case_size) || 1,
      by_store: byStore,
      total_qty: Math.round(totalQty * 10000) / 10000,
      total_value: Math.round(totalValue * 100) / 100,
    };
  });
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return out;
}

/** Material meta for the item pickers of one store. */
export interface StoreItemMeta {
  material_id: string;
  name: string;
  category: string;
  unit: string;
  pack_size: number;
  case_size: number;
  /** ₹ per recipe unit (raw_materials.average_price fallback for valuation). */
  average_price: number;
}

/**
 * The materials a store can hold/move: category-mapped materials (the owner
 * store) UNION any material with a ledger row in that store (so a RECEIVING
 * floor lists exactly what it has been transferred). Category match is
 * TRIM + NOCASE, consistent with materialStoreId().
 */
export function storeItemList(db: Database, storeId: string): StoreItemMeta[] {
  const rows = db.prepare(`
    SELECT rm.id AS material_id, rm.name, rm.category, rm.unit,
           COALESCE(rm.pack_size, 1) AS pack_size, COALESCE(rm.case_size, 1) AS case_size,
           COALESCE(rm.average_price, 0) AS average_price
    FROM raw_materials rm
    WHERE EXISTS (
            SELECT 1 FROM store_category_map m
            WHERE m.store_id = ? AND TRIM(m.category) = TRIM(rm.category) COLLATE NOCASE
          )
       OR EXISTS (
            SELECT 1 FROM store_stock_ledger l
            WHERE l.store_id = ? AND l.material_id = rm.id
          )
    ORDER BY rm.name COLLATE NOCASE
  `).all(storeId, storeId) as any[];
  return rows.map(r => ({
    material_id: r.material_id,
    name: r.name,
    category: r.category,
    unit: r.unit,
    pack_size: Number(r.pack_size) || 1,
    case_size: Number(r.case_size) || 1,
    average_price: Number(r.average_price) || 0,
  }));
}

// ── Store → Store transfers (requisition / issue / receive) ───────────────────

export type TransferStatus = 'requested' | 'issued' | 'received' | 'cancelled';

export interface TransferItemRow {
  id: string;
  transfer_id: string;
  material_id: string;
  material_name: string;
  category: string;
  unit: string;
  pack_size: number;
  case_size: number;
  qty_requested: number;
  qty_issued: number;
  qty_received: number;
  /** qty_issued − qty_received (recipe units still unaccounted). */
  in_transit: number;
  /** qty_issued − qty_received (loss in transit / discrepancy). */
  discrepancy: number;
  note: string;
}

export interface TransferRow {
  id: string;
  from_store_id: string;
  from_store_name: string;
  to_store_id: string;
  to_store_name: string;
  status: TransferStatus;
  note: string;
  requested_by: string;
  requested_at: string | null;
  issued_by: string;
  issued_at: string | null;
  received_by: string;
  received_at: string | null;
  created_at: string;
  updated_at: string;
  items: TransferItemRow[];
  total_requested: number;
  total_issued: number;
  total_received: number;
  total_in_transit: number;
}

export interface TransferSummary {
  id: string;
  from_store_id: string;
  from_store_name: string;
  to_store_id: string;
  to_store_name: string;
  status: TransferStatus;
  note: string;
  requested_by: string;
  requested_at: string | null;
  issued_by: string;
  issued_at: string | null;
  received_by: string;
  received_at: string | null;
  created_at: string;
  updated_at: string;
  item_count: number;
  total_requested: number;
  total_issued: number;
  total_received: number;
  total_in_transit: number;
}

/** Weighted-avg ₹/recipe-unit per material for one store (storeStock-derived). */
function storeAvgCostMap(db: Database, storeId: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of storeStock(db, storeId)) m.set(r.material_id, r.avg_cost);
  return m;
}

function assertActive(db: Database, storeId: string, label: string): StoreLocation {
  const s = getStoreById(db, storeId);
  if (!s) throw new Error(`${label} store not found`);
  if (!s.is_active) throw new Error(`${s.name} is deactivated`);
  return s;
}

/**
 * Create a transfer REQUEST (floor → wants stock from a store, or any
 * store→store). Validates from≠to, both active, each material exists and its
 * qty_requested ≥ 0. Header status = 'requested'. Returns the full transfer.
 */
export function createTransfer(
  db: Database,
  input: {
    from: string;
    to: string;
    items: Array<{ material_id: string; qty_requested?: number; qty?: number; note?: string }>;
    by?: string;
    note?: string;
  },
): TransferRow {
  const fromId = String(input.from || '').trim();
  const toId = String(input.to || '').trim();
  if (!fromId || !toId) throw new Error('from and to store are required');
  if (fromId === toId) throw new Error('Source and destination store must differ');
  assertActive(db, fromId, 'Source');
  assertActive(db, toId, 'Destination');

  const rawItems = Array.isArray(input.items) ? input.items : [];
  const clean: Array<{ material_id: string; qty: number; note: string }> = [];
  for (const it of rawItems) {
    const materialId = String(it?.material_id || '').trim();
    if (!materialId) continue;
    const qty = Number(it?.qty_requested ?? it?.qty ?? 0);
    if (!Number.isFinite(qty) || qty < 0) throw new Error('qty_requested must be a number ≥ 0');
    const mat = db.prepare('SELECT id FROM raw_materials WHERE id = ?').get(materialId);
    if (!mat) throw new Error('Unknown material in transfer');
    clean.push({ material_id: materialId, qty, note: String(it?.note || '') });
  }
  if (clean.length === 0) throw new Error('A transfer needs at least one item');

  const transferId = generateId();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO store_transfers
        (id, from_store_id, to_store_id, status, note, requested_by, requested_at, created_at, updated_at)
      VALUES (?, ?, ?, 'requested', ?, ?, datetime('now'), datetime('now'), datetime('now'))
    `).run(transferId, fromId, toId, String(input.note || ''), String(input.by || ''));
    const insItem = db.prepare(`
      INSERT INTO store_transfer_items
        (id, transfer_id, material_id, qty_requested, note, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `);
    for (const it of clean) insItem.run(generateId(), transferId, it.material_id, it.qty, it.note);
  });
  tx();
  return getTransfer(db, transferId)!;
}

/**
 * ISSUE a requested transfer: debits the FROM store. For every payload item
 * (a subset of the transfer's items) sets qty_issued and, when > 0, posts a
 * NEGATIVE 'transfer' ledger row on the source store carrying the source
 * store's weighted-avg unit_cost (ref = transfer id). Header → 'issued'.
 * Only a 'requested' transfer can be issued.
 */
export function issueTransfer(
  db: Database,
  transferId: string,
  payload: { items: Array<{ material_id: string; qty_issued?: number; qty?: number }>; by?: string },
): TransferRow {
  const t = db.prepare('SELECT * FROM store_transfers WHERE id = ?').get(transferId) as any;
  if (!t) throw new Error('Transfer not found');
  if (t.status !== 'requested') throw new Error(`Only a requested transfer can be issued (status is ${t.status})`);

  const itemRows = db.prepare('SELECT id, material_id, qty_requested FROM store_transfer_items WHERE transfer_id = ?').all(transferId) as { id: string; material_id: string; qty_requested: number }[];
  const byMaterial = new Map(itemRows.map(r => [r.material_id, r]));
  const costMap = storeAvgCostMap(db, t.from_store_id);
  // Current source on-hand per material — a transfer moves REAL stock, so an
  // issue may never exceed what the source physically holds (which would drive
  // the source ledger negative) nor exceed what the floor requested.
  const onHand = new Map<string, number>();
  for (const r of storeStock(db, t.from_store_id)) onHand.set(r.material_id, r.qty);
  const sourceName = getStoreById(db, t.from_store_id)?.name || t.from_store_id;
  const nameOf = (mid: string) =>
    (db.prepare('SELECT name FROM raw_materials WHERE id = ?').get(mid) as { name: string } | undefined)?.name || mid;

  const updates: Array<{ itemId: string; material_id: string; qty: number }> = [];
  for (const it of (payload?.items || [])) {
    const materialId = String(it?.material_id || '').trim();
    if (!materialId) continue;
    const row = byMaterial.get(materialId);
    if (!row) throw new Error('Item is not part of this transfer');
    const qty = Number(it?.qty_issued ?? it?.qty ?? 0);
    if (!Number.isFinite(qty) || qty < 0) throw new Error('qty_issued must be a number ≥ 0');
    const requested = Number(row.qty_requested) || 0;
    if (qty > requested) {
      throw new Error(`Cannot issue more than requested for ${nameOf(materialId)} (requested ${requested}, tried to issue ${qty})`);
    }
    const available = onHand.get(materialId) ?? 0;
    if (qty > available) {
      throw new Error(`Cannot issue ${qty} of ${nameOf(materialId)} — only ${available} on hand in ${sourceName}`);
    }
    updates.push({ itemId: row.id, material_id: materialId, qty });
  }

  const tx = db.transaction(() => {
    for (const u of updates) {
      db.prepare('UPDATE store_transfer_items SET qty_issued = ? WHERE id = ?').run(u.qty, u.itemId);
      if (u.qty > 0) {
        postLedger(db, {
          store_id: t.from_store_id,
          material_id: u.material_id,
          txn_type: 'transfer',
          quantity: -u.qty,
          unit_cost: costMap.get(u.material_id) ?? 0,
          ref: transferId,
          notes: `Transfer issue → ${getStoreById(db, t.to_store_id)?.name || t.to_store_id}`,
          created_by: String(payload?.by || ''),
        });
      }
    }
    db.prepare(`
      UPDATE store_transfers
      SET status = 'issued', issued_by = ?, issued_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(String(payload?.by || ''), transferId);
  });
  tx();
  return getTransfer(db, transferId)!;
}

/**
 * RECEIVE an issued transfer: credits the TO store. For every payload item sets
 * qty_received and, when > 0, posts a POSITIVE 'transfer' ledger row on the
 * destination store carrying the unit_cost from the matching issue row (so
 * valuation follows the stock; falls back to source weighted-avg). Header →
 * 'received'. Only an 'issued' transfer can be received. Per-item discrepancy
 * (qty_issued − qty_received) is surfaced by getTransfer.
 */
export function receiveTransfer(
  db: Database,
  transferId: string,
  payload: { items: Array<{ material_id: string; qty_received?: number; qty?: number }>; by?: string },
): TransferRow {
  const t = db.prepare('SELECT * FROM store_transfers WHERE id = ?').get(transferId) as any;
  if (!t) throw new Error('Transfer not found');
  if (t.status !== 'issued') throw new Error(`Only an issued transfer can be received (status is ${t.status})`);

  const itemRows = db.prepare('SELECT id, material_id, qty_issued FROM store_transfer_items WHERE transfer_id = ?').all(transferId) as { id: string; material_id: string; qty_issued: number }[];
  const byMaterial = new Map(itemRows.map(r => [r.material_id, r]));
  const fallbackCost = storeAvgCostMap(db, t.from_store_id);
  const nameOf = (mid: string) =>
    (db.prepare('SELECT name FROM raw_materials WHERE id = ?').get(mid) as { name: string } | undefined)?.name || mid;
  const getIssueCost = db.prepare(`
    SELECT unit_cost FROM store_stock_ledger
    WHERE store_id = ? AND material_id = ? AND txn_type = 'transfer' AND ref = ? AND quantity < 0
    ORDER BY created_at DESC LIMIT 1
  `);

  const updates: Array<{ itemId: string; material_id: string; qty: number }> = [];
  for (const it of (payload?.items || [])) {
    const materialId = String(it?.material_id || '').trim();
    if (!materialId) continue;
    const row = byMaterial.get(materialId);
    if (!row) throw new Error('Item is not part of this transfer');
    const qty = Number(it?.qty_received ?? it?.qty ?? 0);
    if (!Number.isFinite(qty) || qty < 0) throw new Error('qty_received must be a number ≥ 0');
    // Received may never exceed what was issued: the destination cannot credit
    // more stock than the source debited (conservation), and an item that was
    // never issued (qty_issued = 0) cannot be received. discrepancy
    // (qty_issued − qty_received) is a loss-in-transit and stays ≥ 0.
    const issued = Number(row.qty_issued) || 0;
    if (qty > 0 && issued <= 0) {
      throw new Error(`Cannot receive ${nameOf(materialId)} — it was not issued on this transfer`);
    }
    if (qty > issued) {
      throw new Error(`Cannot receive more than was issued for ${nameOf(materialId)} (issued ${issued}, tried to receive ${qty})`);
    }
    updates.push({ itemId: row.id, material_id: materialId, qty });
  }

  const tx = db.transaction(() => {
    for (const u of updates) {
      db.prepare('UPDATE store_transfer_items SET qty_received = ? WHERE id = ?').run(u.qty, u.itemId);
      if (u.qty > 0) {
        const issueRow = getIssueCost.get(t.from_store_id, u.material_id, transferId) as { unit_cost: number } | undefined;
        const unitCost = issueRow ? Number(issueRow.unit_cost) || 0 : (fallbackCost.get(u.material_id) ?? 0);
        postLedger(db, {
          store_id: t.to_store_id,
          material_id: u.material_id,
          txn_type: 'transfer',
          quantity: u.qty,
          unit_cost: unitCost,
          ref: transferId,
          notes: `Transfer receive ← ${getStoreById(db, t.from_store_id)?.name || t.from_store_id}`,
          created_by: String(payload?.by || ''),
        });
      }
    }
    db.prepare(`
      UPDATE store_transfers
      SET status = 'received', received_by = ?, received_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(String(payload?.by || ''), transferId);
  });
  tx();
  return getTransfer(db, transferId)!;
}

/** Cancel a transfer — allowed ONLY while status = 'requested' (no stock has
 *  moved yet). Returns the updated transfer. */
export function cancelTransfer(db: Database, transferId: string, by?: string): TransferRow {
  const t = db.prepare('SELECT status FROM store_transfers WHERE id = ?').get(transferId) as { status: string } | undefined;
  if (!t) throw new Error('Transfer not found');
  if (t.status !== 'requested') throw new Error(`Only a requested transfer can be cancelled (status is ${t.status})`);
  db.prepare(`
    UPDATE store_transfers
    SET status = 'cancelled', updated_at = datetime('now'),
        note = TRIM(COALESCE(note, '') || CASE WHEN ? <> '' THEN ' [cancelled by ' || ? || ']' ELSE '' END)
    WHERE id = ?
  `).run(String(by || ''), String(by || ''), transferId);
  return getTransfer(db, transferId)!;
}

/** One transfer with its items and computed per-item / header rollups. */
export function getTransfer(db: Database, id: string): TransferRow | null {
  const t = db.prepare(`
    SELECT tr.*, fs.name AS from_store_name, ts.name AS to_store_name
    FROM store_transfers tr
    LEFT JOIN store_locations fs ON fs.id = tr.from_store_id
    LEFT JOIN store_locations ts ON ts.id = tr.to_store_id
    WHERE tr.id = ?
  `).get(id) as any;
  if (!t) return null;

  const itemRows = db.prepare(`
    SELECT ti.*, rm.name AS material_name, rm.category, rm.unit,
           COALESCE(rm.pack_size, 1) AS pack_size, COALESCE(rm.case_size, 1) AS case_size
    FROM store_transfer_items ti
    JOIN raw_materials rm ON rm.id = ti.material_id
    WHERE ti.transfer_id = ?
    ORDER BY rm.name COLLATE NOCASE
  `).all(id) as any[];

  let totalReq = 0, totalIss = 0, totalRec = 0;
  const items: TransferItemRow[] = itemRows.map(r => {
    const qReq = Number(r.qty_requested) || 0;
    const qIss = Number(r.qty_issued) || 0;
    const qRec = Number(r.qty_received) || 0;
    totalReq += qReq; totalIss += qIss; totalRec += qRec;
    const diff = Math.round((qIss - qRec) * 10000) / 10000;
    return {
      id: r.id,
      transfer_id: r.transfer_id,
      material_id: r.material_id,
      material_name: r.material_name,
      category: r.category,
      unit: r.unit,
      pack_size: Number(r.pack_size) || 1,
      case_size: Number(r.case_size) || 1,
      qty_requested: qReq,
      qty_issued: qIss,
      qty_received: qRec,
      in_transit: diff,
      discrepancy: diff,
      note: r.note || '',
    };
  });

  return {
    id: t.id,
    from_store_id: t.from_store_id,
    from_store_name: t.from_store_name || t.from_store_id,
    to_store_id: t.to_store_id,
    to_store_name: t.to_store_name || t.to_store_id,
    status: t.status,
    note: t.note || '',
    requested_by: t.requested_by || '',
    requested_at: t.requested_at || null,
    issued_by: t.issued_by || '',
    issued_at: t.issued_at || null,
    received_by: t.received_by || '',
    received_at: t.received_at || null,
    created_at: t.created_at,
    updated_at: t.updated_at,
    items,
    total_requested: Math.round(totalReq * 10000) / 10000,
    total_issued: Math.round(totalIss * 10000) / 10000,
    total_received: Math.round(totalRec * 10000) / 10000,
    total_in_transit: Math.round((totalIss - totalRec) * 10000) / 10000,
  };
}

/**
 * List transfers (headers + rollups, no item rows) filtered by an optional
 * store (matches FROM or TO) and/or status. Newest first.
 */
export function listTransfers(
  db: Database,
  opts?: { storeId?: string; status?: TransferStatus },
): TransferSummary[] {
  const where: string[] = [];
  const args: any[] = [];
  if (opts?.storeId) { where.push('(tr.from_store_id = ? OR tr.to_store_id = ?)'); args.push(opts.storeId, opts.storeId); }
  if (opts?.status)  { where.push('tr.status = ?'); args.push(opts.status); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT tr.*, fs.name AS from_store_name, ts.name AS to_store_name,
           (SELECT COUNT(*)               FROM store_transfer_items ti WHERE ti.transfer_id = tr.id) AS item_count,
           (SELECT COALESCE(SUM(ti.qty_requested), 0) FROM store_transfer_items ti WHERE ti.transfer_id = tr.id) AS total_requested,
           (SELECT COALESCE(SUM(ti.qty_issued), 0)    FROM store_transfer_items ti WHERE ti.transfer_id = tr.id) AS total_issued,
           (SELECT COALESCE(SUM(ti.qty_received), 0)  FROM store_transfer_items ti WHERE ti.transfer_id = tr.id) AS total_received
    FROM store_transfers tr
    LEFT JOIN store_locations fs ON fs.id = tr.from_store_id
    LEFT JOIN store_locations ts ON ts.id = tr.to_store_id
    ${whereSql}
    ORDER BY tr.created_at DESC
  `).all(...args) as any[];

  return rows.map(r => {
    const totalIss = Number(r.total_issued) || 0;
    const totalRec = Number(r.total_received) || 0;
    return {
      id: r.id,
      from_store_id: r.from_store_id,
      from_store_name: r.from_store_name || r.from_store_id,
      to_store_id: r.to_store_id,
      to_store_name: r.to_store_name || r.to_store_id,
      status: r.status,
      note: r.note || '',
      requested_by: r.requested_by || '',
      requested_at: r.requested_at || null,
      issued_by: r.issued_by || '',
      issued_at: r.issued_at || null,
      received_by: r.received_by || '',
      received_at: r.received_at || null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      item_count: Number(r.item_count) || 0,
      total_requested: Math.round((Number(r.total_requested) || 0) * 10000) / 10000,
      total_issued: Math.round(totalIss * 10000) / 10000,
      total_received: Math.round(totalRec * 10000) / 10000,
      total_in_transit: Math.round((totalIss - totalRec) * 10000) / 10000,
    };
  });
}
