/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Smart Reorder → draft Purchase Orders (pure DB logic, no HTTP/auth).
 *
 * Creates DRAFT purchase orders through the SAME shape/steps as
 * POST /api/purchase-orders (that route is deliberately untouched):
 *   - po_number   = next PO-YYYY-NNNN            (mirrors nextPoNumber)
 *   - status      = 'draft'                      (normal approval flow applies:
 *                    submit → pending → approve → receive, exactly as if the
 *                    PO had been drafted on the Purchase Orders page)
 *   - line totals = round(qty × unit_price, 2), header total re-summed from
 *                    lines                        (mirrors recalcTotal)
 *   - header vendor derived from line vendors     (mirrors deriveHeaderVendor)
 *
 * One PO per vendor; items with NO vendor group into a single unassigned PO
 * (purchase_orders.vendor_id is nullable and vendor defaults to '' — the buyer
 * assigns a vendor while the PO is still a draft).
 *
 * Kept in its own lib so /api/crm/reorder stays thin and the logic can be
 * smoke-tested against the real DB without a request context.
 */
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';

type DB = Database.Database;

export interface ReorderPoItemInput {
  material_id: string;
  qty: number;               // in PURCHASE units (PO convention)
  vendor_id: string | null;
  unit_price: number;        // ₹ per purchase unit
}

export interface CreatedReorderPo {
  id: string;
  po_number: string;
  vendor_name: string;       // 'Unassigned' for the no-vendor group
  total: number;
}

/** Mirrors nextPoNumber in /api/purchase-orders/route.ts. */
function nextPoNumber(db: DB, isoDate: string): string {
  const year = isoDate.slice(0, 4);
  const lastRow = db.prepare(`
    SELECT po_number FROM purchase_orders
    WHERE po_number LIKE 'PO-' || ? || '-%'
    ORDER BY po_number DESC LIMIT 1
  `).get(year) as any;
  const last = lastRow?.po_number ? parseInt(lastRow.po_number.split('-').pop() || '0', 10) : 0;
  return `PO-${year}-${String(last + 1).padStart(4, '0')}`;
}

/** Mirrors recalcTotal in /api/purchase-orders/route.ts. */
function recalcTotal(db: DB, poId: string) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(total_price), 0) AS t FROM purchase_order_items WHERE po_id = ?
  `).get(poId) as any;
  db.prepare(`UPDATE purchase_orders SET total_cost = ?, updated_at = datetime('now') WHERE id = ?`).run(r.t, poId);
}

/** Mirrors deriveHeaderVendor in /api/purchase-orders/route.ts. */
function deriveHeaderVendor(db: DB, poId: string) {
  const rows = db.prepare(`
    SELECT vendor, vendor_id, COUNT(*) AS n
    FROM purchase_order_items
    WHERE po_id = ? AND vendor IS NOT NULL AND TRIM(vendor) != ''
    GROUP BY vendor, vendor_id
    ORDER BY n DESC
  `).all(poId) as any[];
  if (rows.length === 0) return;
  if (rows.length === 1) {
    db.prepare(`UPDATE purchase_orders SET vendor = ?, vendor_id = ? WHERE id = ?`)
      .run(rows[0].vendor, rows[0].vendor_id, poId);
  } else {
    db.prepare(`UPDATE purchase_orders SET vendor = ?, vendor_id = NULL WHERE id = ?`)
      .run(`Mixed (${rows.length} vendors)`, poId);
  }
}

/**
 * Validate + group items by vendor + create one DRAFT PO per group.
 * Throws Error with a user-facing message on bad input (caller maps to 400).
 * All writes happen in ONE transaction — either every PO lands or none do.
 */
export function createDraftPosFromReorder(
  db: DB,
  items: ReorderPoItemInput[],
  actor: string,
  outletId: string | null,
): CreatedReorderPo[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('items array required');
  }

  // ── validate every line up-front (nothing written on a bad payload) ──
  const matStmt = db.prepare(`SELECT id, name FROM raw_materials WHERE id = ?`);
  const vendorStmt = db.prepare(`SELECT id, name FROM vendors WHERE id = ?`);
  const vendorNames = new Map<string, string>();
  for (const it of items) {
    const qty = Number(it?.qty);
    const px = Number(it?.unit_price);
    if (!it?.material_id || !matStmt.get(String(it.material_id))) {
      throw new Error(`Unknown material: ${it?.material_id || '(missing)'}`);
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error('Each item needs a quantity > 0');
    }
    if (!Number.isFinite(px) || px < 0) {
      throw new Error('Each item needs a unit price ≥ 0');
    }
    if (it.vendor_id) {
      const v = vendorStmt.get(String(it.vendor_id)) as any;
      if (!v) throw new Error(`Unknown vendor: ${it.vendor_id}`);
      vendorNames.set(String(it.vendor_id), v.name);
    }
  }

  // ── group by vendor ('' = unassigned bucket) ──
  const groups = new Map<string, ReorderPoItemInput[]>();
  for (const it of items) {
    const key = it.vendor_id ? String(it.vendor_id) : '';
    const arr = groups.get(key) || [];
    arr.push(it); groups.set(key, arr);
  }

  const isoDate = new Date().toISOString().slice(0, 10);
  const created: CreatedReorderPo[] = [];

  const txn = db.transaction(() => {
    for (const [vendorKey, groupItems] of groups) {
      const vendorId = vendorKey || null;
      const vendorName = vendorId ? (vendorNames.get(vendorKey) || '') : '';

      const id = generateId();
      // Computed INSIDE the transaction, after each prior insert, so multiple
      // POs in one call get sequential numbers (no collision).
      const poNumber = nextPoNumber(db, isoDate);

      db.prepare(`
        INSERT INTO purchase_orders (id, po_number, date, vendor_id, vendor, status, notes, drafted_by, outlet_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, datetime('now'), datetime('now'))
      `).run(id, poNumber, isoDate, vendorId, vendorName, 'Created from Smart Reorder (AI suggestions)', actor, outletId);

      const insItem = db.prepare(`
        INSERT INTO purchase_order_items (id, po_id, material_id, quantity, unit_price, total_price, vendor, vendor_id, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const it of groupItems) {
        const qty = Number(it.qty) || 0;
        const px = Number(it.unit_price) || 0;
        insItem.run(generateId(), id, it.material_id, qty, px,
                    Math.round(qty * px * 100) / 100,
                    vendorName, vendorId, '');
      }
      recalcTotal(db, id);
      deriveHeaderVendor(db, id);

      const fresh = db.prepare(`SELECT total_cost FROM purchase_orders WHERE id = ?`).get(id) as any;
      created.push({
        id,
        po_number: poNumber,
        vendor_name: vendorName || 'Unassigned',
        total: Math.round((Number(fresh?.total_cost) || 0) * 100) / 100,
      });
    }
  });
  txn();

  return created;
}
