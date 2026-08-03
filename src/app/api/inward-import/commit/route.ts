import * as XLSX from 'xlsx';
import { randomUUID } from 'crypto';
import { getDb, updateMaterialPrice } from '@/lib/db';
import {
  parseInwardWorkbook, mapCategory, mapUnit, packSize, parseMaterialVolumeMl,
} from '@/lib/recaho-inward';
import { requireRole, getCurrentOutletId } from '@/lib/auth';
import { findUnitLock } from '@/lib/unit-audit-lock';
import { centralFlowBlock, isStoreMappedMaterial } from '@/lib/store-engine';

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
 *       total_price = quantity × unit_price (GOODS only). Every charge the sheet
 *       carries travels BESIDE the rate in its own column — GST is a reclaimable
 *       input credit and must never enter a rate, a total or a recipe cost;
 *       TGBCL excise / TCS is non-creditable landed cost and is recorded apart
 *       from GST so the two are never confused on a return.
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

    // Cache lookups so we don't re-query on every row.
    // pack_size + purchase_unit are REQUIRED by the stock conversion below
    // (packConv) — omitting them silently made packConv=1 for every material,
    // bumping pack materials' stock in PURCHASE units instead of recipe units.
    const matByKey = new Map<string, {
      id: string; name: string; unit: string;
      purchase_unit: string | null; pack_size: number | null;
    }>();
    for (const m of db.prepare('SELECT id, name, unit, purchase_unit, pack_size FROM raw_materials').all() as any[]) {
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
      INSERT INTO purchases (
        id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes, outlet_id,
        discount, cgst, sgst, special_excise_cess, tcs, delivery_charges, mrp_round_off, created_at
      )
      VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
                    // Phase B store guard — liquor rows skipped (batch: per-line, never fail the file)
                    store_blocked: [] as Array<{ material: string; error: string }>,
                    unit_audit_warnings: [] as Array<{
                      material: string; sku?: string;
                      locked_purchase_unit?: string; incoming_purchase_unit?: string;
                      reason: string;
                    }>,
                    // Rows whose sheet TOTAL does not reconcile against the charge
                    // columns we can actually store. Reported, never folded.
                    charge_warnings: [] as Array<{
                      material: string; vendor: string;
                      expected: number; recorded: number; unreconciled: number;
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
            mat = { id, name: r.itemName, unit, purchase_unit: purchaseUnit, pack_size: packSize };
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

          // Phase B store guard (batch → skip + report per row): store-mapped
          // materials (liquor) never enter Central purchases/stock via imports.
          // The master row above may still be created/reused — harmless; only
          // the purchase + stock movement is blocked. Use the Liquor Store page.
          const storeMsg = centralFlowBlock(db, mat.id);
          if (storeMsg) {
            stats.store_blocked.push({ material: r.itemName, error: storeMsg });
            stats.skipped++;
            continue;
          }

          // Store the purchases ROW in PURCHASE units (qty = bottles/pieces, rate =
          // ₹ per purchase unit) so updateMaterialPrice (which ÷pack) stays correct;
          // bump STOCK in RECIPE units via the material's pack_size. The old code
          // stored ml-basis rows AND divided the rate, which corrupted average_price
          // ~pack× (Jameson ₹2.85/BTL instead of ₹2,421). Now aligned with every
          // other purchase path (purchases/opening-stock use material.pack_size).
          const casePack = packSize(r.purchaseUnit);              // pieces per case (e.g. 24), else 1
          const purchaseQty  = r.inwardQty * casePack;            // in PURCHASE units (bottles/pieces)
          const purchaseRate = casePack > 1 ? r.rate / casePack : r.rate;  // ₹ per purchase unit

          if (purchaseQty <= 0) { stats.skipped++; continue; }

          const matPack = Number(mat.pack_size) || 1;             // recipe units per purchase unit
          const ru = String(mat.unit || '').toLowerCase();
          const pu = String(mat.purchase_unit || mat.unit || '').toLowerCase();
          const packConv = (matPack > 1 && ru !== pu) ? matPack : 1;
          const stockQty       = purchaseQty * packConv;          // RECIPE units for stock + tx
          const recipeUnitRate = purchaseRate / packConv;         // ₹ per recipe unit (matches average_price basis)

          const purchaseId = randomUUID();
          const date = r.inwardDate || new Date().toISOString().split('T')[0];

          // total_price is the GOODS value, nothing else. It used to be bound
          // from r.totalAmount ("TOTAL INWARD AMOUNT"), which is tax-INCLUSIVE,
          // while unit_price held the clean purchase rate — so reclaimable GST
          // was folded into spend and the sheet's own CGST/SGST were dropped on
          // the floor. Binding qty × rate makes the house identity
          // total_price = quantity × unit_price hold by construction (measured:
          // the sheet's SUBTOTAL equals qty × rate to within ₹0.005 on all
          // 10,012 detail rows of the three real exports).
          // Recipe cost cannot move: updateMaterialPrice reads
          // SUM(quantity × unit_price)/SUM(quantity) and never total_price.
          const goods = Math.round(purchaseQty * purchaseRate * 100) / 100;

          // Zero-rating wins over whatever the sheet says. A store-mapped line
          // bears TGBCL duty on the store bill and no GST on our side. In
          // practice centralFlowBlock above already skipped it; this is the
          // second lock, for the day that guard is relaxed per-category.
          const zeroRated = isStoreMappedMaterial(db, mat.id);

          // Re-derive the split from the sheet's tax TOTAL instead of storing
          // r.cgst / r.sgst verbatim: Recaho emits 3-dp halves (454.283 each)
          // which cannot both round to 2 dp and still satisfy the invariant
          // tax_value = cgst + sgst that every reader re-adds. Whole paise, odd
          // paisa to CGST — the canon lives at api/purchases/route.ts:363-367.
          const taxValue = zeroRated ? 0 : Math.round((r.cgst + r.sgst) * 100) / 100;
          const taxPaise = Math.round(taxValue * 100);
          const sgst = Math.floor(taxPaise / 2) / 100;
          const cgst = Math.round((taxValue - sgst) * 100) / 100;

          // The non-creditable bucket, kept apart from GST on purpose. The sheet
          // ships ONE combined "TCS + SPECIAL EXCISE CESS" figure we cannot
          // honestly split, and on TGBCL lines it runs ~11.5% of subtotal —
          // Indian TCS is 0.1-1%, so the money is overwhelmingly special excise
          // cess. It lands in special_excise_cess (with EXCISE added in) and
          // `tcs` stays 0 rather than carrying a number we invented. The
          // verbatim sheet label rides along in the row note as provenance.
          // Mapped per COLUMN, never per vendor: 12 of the 10,012 real detail
          // rows carry this levy WITHOUT being billed by GOVERNMENT OF TELANGANA,
          // and 21 GST rows also carry delivery. An if/else on vendor silently
          // drops one side of those; the sheet already separates them per line.
          const specialCess = Math.round((r.tcsPlusSpecialCess + r.excise) * 100) / 100;
          const discountAmt = Math.round(r.discount * 100) / 100;
          const deliveryAmt = Math.round(r.deliveryCharges * 100) / 100;
          const mrpRoundOff = Math.round(r.mrpRoundOff * 100) / 100;

          // Residual guard. VAT and GST-compensation CESS are real sheet columns
          // with no DB home (0 on every row of the real exports so far). Folding
          // them into special_excise_cess would report an excise figure the
          // government never levied, so instead the row commits with its correct
          // goods value and the unreconciled rupees are named. Money is never
          // silently lost and never silently mis-posted. Worst-case measured
          // reconciliation error on real data is ₹0.12, so ₹1.00 is signal.
          const recorded = Math.round(
            (goods - discountAmt + cgst + sgst + specialCess + deliveryAmt + mrpRoundOff) * 100
          ) / 100;
          const resid = Math.round((r.totalAmount - recorded) * 100) / 100;
          if (Math.abs(resid) > 1) {
            stats.charge_warnings.push({
              material: r.itemName, vendor: r.supplier || 'unknown vendor',
              expected: Math.round(r.totalAmount * 100) / 100, recorded, unreconciled: resid,
              reason: 'Sheet TOTAL INWARD AMOUNT does not reconcile against the charge columns we can store (VAT / GST compensation cess have no column yet). Goods value recorded correctly; the difference is NOT inside the rate.',
            });
          }
          if (zeroRated && (r.cgst + r.sgst) > 0) {
            const dropped = Math.round((r.cgst + r.sgst) * 100) / 100;
            stats.charge_warnings.push({
              material: r.itemName, vendor: r.supplier || 'unknown vendor',
              expected: dropped, recorded: 0, unreconciled: dropped,
              reason: 'Store-mapped (liquor) line carried GST on the sheet. Zero-rating wins — no input credit recorded on our side.',
            });
          }

          const noteBits = [r.notes || 'Imported from inward report'];
          if (taxValue > 0) {
            noteBits.push(`GST ₹${taxValue.toFixed(2)} (CGST ₹${cgst.toFixed(2)} + SGST ₹${sgst.toFixed(2)}, not in rate)`);
          }
          if (specialCess !== 0) {
            noteBits.push(`TGBCL TCS + Special Excise Cess ₹${specialCess.toFixed(2)} (sheet column, non-creditable landed cost)`);
          }

          insertPurchase.run(
            purchaseId, mat.id, r.supplier, purchaseQty, purchaseRate, goods, date,
            noteBits.join(' · '), outletId,
            discountAmt, cgst, sgst, specialCess, 0, deliveryAmt, mrpRoundOff,
          );
          insertTx.run(randomUUID(), mat.id, stockQty, purchaseId,
                       `Inward import — ${r.supplier || 'unknown vendor'}`, outletId);
          bumpStock.run(stockQty, recipeUnitRate, date, mat.id);

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
