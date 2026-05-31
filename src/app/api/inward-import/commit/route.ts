import * as XLSX from 'xlsx';
import { randomUUID } from 'crypto';
import { getDb, updateMaterialPrice } from '@/lib/db';
import {
  parseInwardWorkbook, mapCategory, mapUnit, packSize, parseMaterialVolumeMl,
} from '@/lib/recaho-inward';
import { requireRole, getCurrentOutletId } from '@/lib/auth';
import { findUnitLock } from '@/lib/unit-audit-lock';

/**
 * Step 2 — actually persist the inward report into the DB.
 *
 * For each parsed row:
 *   - Upsert the supplier into the `vendors` master (by name).
 *   - Upsert the raw_material by lower-cased name. New materials use mapCategory + mapUnit.
 *   - Convert quantity into the material's stock unit:
 *       1) expand pack: rawQty × packSize(purchaseUnit)
 *       2) for ml/l materials with a pack volume in the name, multiply by that volume
 *      so e.g. "20 CASE(24PC) of BUDWEISER (330ML)" → 20×24×330 = 158,400 ml
 *   - Insert into purchases (outlet-scoped to the user's current outlet).
 *   - Insert into inventory_transactions (audit trail).
 *   - Bump raw_materials.current_stock + last_purchase_price + last_purchase_date.
 *
 * After the loop, re-runs updateMaterialPrice() per touched material (cascades the
 * new weighted-average back into recipe + sub-recipe costs).
 */
export async function POST(req: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  try {
    const fd = await req.formData();
    const file = fd.get('file');
    if (!file || !(file instanceof Blob)) {
      return Response.json({ error: 'file field missing' }, { status: 400 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const wb = XLSX.read(buf, { type: 'buffer' });
    const rows = parseInwardWorkbook(XLSX, wb);

    if (rows.length === 0) {
      return Response.json({ error: 'No detail rows found in file.' }, { status: 400 });
    }

    const db = getDb();
    const outletId = await getCurrentOutletId();
    if (!outletId) return Response.json({ error: 'No current outlet' }, { status: 400 });

    // Cache lookups so we don't re-query on every row
    const matByKey = new Map<string, { id: string; name: string; unit: string }>();
    for (const m of db.prepare('SELECT id, name, unit FROM raw_materials').all() as any[]) {
      matByKey.set(m.name.toLowerCase().trim(), m);
    }
    const vendorByName = new Map<string, string>();
    for (const v of db.prepare('SELECT id, name FROM vendors').all() as any[]) {
      vendorByName.set(v.name.toLowerCase().trim(), v.id);
    }

    const insertMaterial = db.prepare(`
      INSERT INTO raw_materials (id, name, category, unit, purchase_unit, pack_size, case_size, current_stock, reorder_level, costing_method, average_price, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'average', 0, datetime('now'), datetime('now'))
    `);
    const insertVendor = db.prepare(`
      INSERT INTO vendors (id, name, is_active, created_at, updated_at)
      VALUES (?, ?, 1, datetime('now'), datetime('now'))
    `);
    const insertPurchase = db.prepare(`
      INSERT INTO purchases (id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes, outlet_id, created_at)
      VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    const insertTx = db.prepare(`
      INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, outlet_id, created_at)
      VALUES (?, ?, 'purchase', ?, ?, ?, ?, datetime('now'))
    `);
    const bumpStock = db.prepare(`
      UPDATE raw_materials
      SET current_stock = current_stock + ?,
          last_purchase_price = ?,
          last_purchase_date  = ?,
          updated_at          = datetime('now')
      WHERE id = ?
    `);

    const stats = { purchases: 0, newMaterials: 0, reusedMaterials: 0,
                    newVendors: 0, skipped: 0, errors: [] as string[],
                    unit_audit_warnings: [] as Array<{
                      material: string; sku?: string;
                      locked_purchase_unit?: string; incoming_purchase_unit?: string;
                      reason: string;
                    }> };
    const touchedMaterials = new Set<string>();

    const txn = db.transaction(() => {
      for (const r of rows) {
        try {
          // Vendor upsert
          if (r.supplier) {
            const vk = r.supplier.toLowerCase().trim();
            if (!vendorByName.has(vk)) {
              const vid = randomUUID();
              insertVendor.run(vid, r.supplier);
              vendorByName.set(vk, vid);
              stats.newVendors++;
            }
          }

          // Material upsert.
          // The unit_audit_lock (if any) is the source of truth — both for
          // hydrating a brand-new material and for detecting drift on an
          // existing one. Existing materials NEVER have their unit fields
          // mutated by a purchase import; if the incoming row would imply a
          // different unit, we record a warning and leave the material alone.
          const key = r.itemName.toLowerCase().trim();
          let mat = matByKey.get(key);
          const lock = findUnitLock(db, { name: r.itemName });
          if (!mat) {
            const id = randomUUID();
            const incomingUnit = mapUnit(r.purchaseUnit);
            // Prefer the locked unit fields when creating, so a wipe+reupload
            // restores the curated audit. Fall back to inferred-from-purchase.
            const unit         = lock?.recipe_unit   || incomingUnit;
            const purchaseUnit = lock?.purchase_unit || incomingUnit;
            const packSize     = lock?.pack_size     ?? 1;
            const caseSize     = lock?.case_size     ?? 1;
            const category     = lock?.category      || mapCategory(r.category);
            insertMaterial.run(id, r.itemName, category, unit, purchaseUnit, packSize, caseSize);
            mat = { id, name: r.itemName, unit };
            matByKey.set(key, mat);
            stats.newMaterials++;
            // If incoming differs from locked unit, surface a warning so admin
            // can re-upload a fixed audit covering it.
            if (lock && lock.purchase_unit && lock.purchase_unit !== incomingUnit) {
              stats.unit_audit_warnings.push({
                material: r.itemName,
                sku: lock.sku || undefined,
                locked_purchase_unit: lock.purchase_unit,
                incoming_purchase_unit: incomingUnit,
                reason: 'New material hydrated from lock; purchase row implies a different unit.',
              });
            }
          } else {
            stats.reusedMaterials++;
            // Drift check on existing material.
            if (lock) {
              const incomingUnit = mapUnit(r.purchaseUnit);
              if (lock.purchase_unit && lock.purchase_unit !== incomingUnit) {
                stats.unit_audit_warnings.push({
                  material: r.itemName,
                  sku: lock.sku || undefined,
                  locked_purchase_unit: lock.purchase_unit,
                  incoming_purchase_unit: incomingUnit,
                  reason: 'Purchase row unit differs from locked unit-audit. Material units left unchanged.',
                });
              }
            }
          }

          // Convert qty + price into the material's stock unit
          const pack = packSize(r.purchaseUnit);
          let qty   = r.inwardQty * pack;            // first expand case → pieces
          let rate  = pack > 1 ? r.rate / pack : r.rate;

          if (mat.unit === 'ml' || mat.unit === 'l') {
            const volMl = parseMaterialVolumeMl(mat.name);
            if (volMl) {
              const factor = mat.unit === 'l' ? volMl / 1000 : volMl;
              qty = qty * factor;
              rate = rate / factor;
            }
          }

          if (qty <= 0) { stats.skipped++; continue; }

          const purchaseId = randomUUID();
          const date = r.inwardDate || new Date().toISOString().split('T')[0];
          insertPurchase.run(
            purchaseId, mat.id, r.supplier, qty, rate, r.totalAmount, date,
            r.notes || `Imported from inward report`, outletId,
          );
          insertTx.run(randomUUID(), mat.id, qty, purchaseId,
                       `Inward import — ${r.supplier || 'unknown vendor'}`, outletId);
          bumpStock.run(qty, rate, date, mat.id);

          touchedMaterials.add(mat.id);
          stats.purchases++;
        } catch (e: any) {
          stats.errors.push(`row ${stats.purchases + stats.skipped}: ${e.message}`);
          stats.skipped++;
        }
      }
    });
    txn();

    // Recompute weighted-avg + cascade to recipes outside the txn (it does its own writes)
    for (const id of touchedMaterials) updateMaterialPrice(db, id);

    return Response.json({
      success: true,
      ...stats,
      materials_touched: touchedMaterials.size,
    });
  } catch (e: any) {
    console.error('[inward-import/commit]', e);
    return Response.json({ error: e.message || 'Failed to import' }, { status: 500 });
  }
}
