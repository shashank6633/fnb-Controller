import { getDb, generateId, updateMaterialPrice } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { centralFlowBlock } from '@/lib/store-engine';

/**
 * Opening-stock import — seed go-live stock + cost from a filled template.
 *
 * The operator fills the template in NATURAL purchase units (kg, BTL, CASE…)
 * — e.g. "20 kg @ ₹141" or "12 BTL @ ₹2000" — exactly as they physically count.
 *
 * Storage model mirrors the daily Recaho/bulk import so everything stays
 * consistent:
 *   - the purchase ROW keeps qty + rate in PURCHASE units (so updateMaterialPrice
 *     derives the right ₹-per-recipe-unit average via its rate ÷ pack_size step);
 *   - current_stock is incremented in RECIPE units (qty × pack_size) because the
 *     rest of the app (sales deduction, closing-stock variance × average_price)
 *     keeps stock in recipe units.
 * The pack_size multiplier is applied ONLY when recipe_unit ≠ purchase_unit,
 * exactly matching updateMaterialPrice()'s own guard.
 *
 * POST body: { rows: [{ sku?, name?, qty, rate, date? }] }
 *   - material resolved by sku first, then by name (case-insensitive)
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const db = getDb();
    const body = await request.json();
    const rows: any[] = Array.isArray(body?.rows) ? body.rows : [];
    if (rows.length === 0) return Response.json({ error: 'rows array required' }, { status: 400 });

    const today = new Date().toISOString().slice(0, 10);
    const mats = db.prepare('SELECT id, sku, name, pack_size, purchase_unit, unit FROM raw_materials').all() as any[];
    const bySku = new Map<string, any>();
    const byName = new Map<string, any>();
    for (const m of mats) {
      if (m.sku) bySku.set(String(m.sku).toLowerCase().trim(), m);
      byName.set(String(m.name).toLowerCase().trim(), m);
    }

    const insPurchase = db.prepare(`
      INSERT INTO purchases (id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes, created_at)
      VALUES (?, ?, 'Opening Stock', '', ?, ?, ?, ?, 'Opening stock (go-live)', datetime('now'))
    `);
    const updStock = db.prepare(`UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now') WHERE id = ?`);
    const insTxn = db.prepare(`
      INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
      VALUES (?, ?, 'purchase', ?, ?, 'Opening stock', datetime('now'))
    `);

    const created: any[] = [];
    const skipped: any[] = [];
    // Store guard (liquor) — rows skipped because the material is store-mapped.
    // Per-line skip + report, mirroring inward-import: never fail the batch.
    const store_blocked: Array<{ row: number; material: string; error: string }> = [];

    const run = db.transaction(() => {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] || {};
        const rowNo = i + 1;
        const qty  = Number(r.qty  ?? r.quantity ?? r.opening_qty ?? 0);
        const rate = Number(r.rate ?? r.unit_price ?? r.price ?? 0);
        const date = (typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) ? r.date : today;

        const skuKey  = String(r.sku  ?? '').toLowerCase().trim();
        const nameKey = String(r.name ?? r.item_name ?? '').toLowerCase().trim();
        // Skip blank template rows silently (qty + rate both empty, no id).
        if (!qty && !rate && !skuKey && !nameKey) continue;

        const m = (skuKey && bySku.get(skuKey)) || (nameKey && byName.get(nameKey)) || null;
        if (!m) { skipped.push({ row: rowNo, reason: `material not found (sku="${r.sku || ''}" name="${r.name || ''}")` }); continue; }

        // Store guard: store-mapped materials (liquor) never enter Central
        // purchases/stock via opening-stock — skip the line, report, keep going.
        const storeMsg = centralFlowBlock(db, m.id);
        if (storeMsg) { store_blocked.push({ row: rowNo, material: m.name, error: storeMsg }); continue; }

        if (!(qty > 0) || !(rate > 0)) { skipped.push({ row: rowNo, name: m.name, reason: 'qty and rate must both be > 0' }); continue; }

        const packSize = Number(m.pack_size) || 1;
        const recipeUnit   = String(m.unit || '').toLowerCase().trim();
        const purchaseUnit = String(m.purchase_unit || m.unit || '').toLowerCase().trim();
        // Convert purchase-unit → recipe-unit for STOCK only when the units
        // actually differ (kg→g, L→ml). Mirrors updateMaterialPrice()'s guard so
        // price and stock conversions always apply to the same set of materials.
        const conv = (packSize > 1 && recipeUnit !== purchaseUnit) ? packSize : 1;
        const stockQty = qty * conv;                          // recipe/stock units
        const total = Math.round(qty * rate * 100) / 100;     // invoice amount (purchase units)
        const pid = generateId();
        // Row in PURCHASE units + per-purchase-unit rate (same as bulk import) →
        // updateMaterialPrice() turns it into the correct ₹-per-recipe-unit average.
        insPurchase.run(pid, m.id, qty, rate, total, date);
        updStock.run(stockQty, m.id);
        insTxn.run(generateId(), m.id, stockQty, pid);
        updateMaterialPrice(db, m.id);
        created.push({ row: rowNo, name: m.name, entered: `${qty} ${m.purchase_unit || ''}`, base: `${stockQty} ${m.unit || ''}` });
      }
    });
    run();

    return Response.json({
      success: created.length,
      skipped: skipped.length,
      skipped_rows: skipped.slice(0, 200),
      store_blocked,
      message: `Created ${created.length} opening-stock entr${created.length === 1 ? 'y' : 'ies'}`
             + (skipped.length ? ` · ${skipped.length} skipped` : '')
             + (store_blocked.length ? ` · ${store_blocked.length} store-mapped (use the store's own procurement)` : '') + '.',
    }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/purchases/opening-stock]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
