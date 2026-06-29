import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Opening-stock import — seed go-live stock + cost from a filled template.
 *
 * Unlike /api/purchases/bulk (which expects quantities already in the base
 * recipe unit), this endpoint takes quantities + rate in the material's
 * PURCHASE unit (kg, BTL, CASE…) and converts to base units via pack_size, so
 * the operator can enter "20 kg @ ₹141" or "12 BTL @ ₹2000" as they physically
 * count. Each row becomes a Purchase (vendor "Opening Stock") which updates
 * current_stock and the weighted-average price.
 *
 * POST body: { rows: [{ sku?, name?, qty, rate, date? }] }
 *   - material resolved by sku first, then by name (case-insensitive)
 *   - base_qty   = qty  × pack_size   (recipe units)
 *   - base_price = rate ÷ pack_size   (₹ per recipe unit)
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
        if (!(qty > 0) || !(rate > 0)) { skipped.push({ row: rowNo, name: m.name, reason: 'qty and rate must both be > 0' }); continue; }

        const packSize = Number(m.pack_size) > 1 ? Number(m.pack_size) : 1;
        const baseQty = qty * packSize;                         // recipe units
        const baseUnitPrice = packSize > 0 ? rate / packSize : rate; // ₹ per recipe unit
        const total = Math.round(baseQty * baseUnitPrice * 100) / 100;
        const pid = generateId();
        insPurchase.run(pid, m.id, baseQty, baseUnitPrice, total, date);
        updStock.run(baseQty, m.id);
        insTxn.run(generateId(), m.id, baseQty, pid);
        // Set average_price to the per-RECIPE-unit weighted average over this
        // material's purchases. Computed directly (not via updateMaterialPrice,
        // which divides the average by pack_size again — our quantities/prices
        // are already in recipe units, so that would 1000× under-price the item).
        const agg = db.prepare('SELECT SUM(quantity * unit_price) AS tv, SUM(quantity) AS tq FROM purchases WHERE material_id = ?').get(m.id) as any;
        if (agg && agg.tq > 0) {
          db.prepare("UPDATE raw_materials SET average_price = ?, updated_at = datetime('now') WHERE id = ?")
            .run(Math.round((agg.tv / agg.tq) * 10000) / 10000, m.id);
        }
        created.push({ row: rowNo, name: m.name, entered: `${qty} ${m.purchase_unit || ''}`, base: `${baseQty} ${m.unit || ''}` });
      }
    });
    run();

    return Response.json({
      success: created.length,
      skipped: skipped.length,
      skipped_rows: skipped.slice(0, 200),
      message: `Created ${created.length} opening-stock entr${created.length === 1 ? 'y' : 'ies'}`
             + (skipped.length ? ` · ${skipped.length} skipped` : '') + '.',
    }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/purchases/opening-stock]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
