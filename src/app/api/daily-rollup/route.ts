import { getDb } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';

/**
 * Daily Closing Roll-up — Phase 1 §6 spec.
 *
 *   For each (material, day) in the requested range:
 *     Opening   = current_stock at start-of-day
 *               = (purchases before day) − (sales/party/staff_meal/wastage before day)
 *     Received  = purchases ON the day
 *     Consumed  = recipe + wastage ON the day
 *     Closing   = Opening + Received − Consumed
 *     Counted   = closing_stock.physical_stock for the day (NULL if no count)
 *     Variance  = Closing − Counted  (positive = leakage between recorded & physical)
 *
 * Query params:
 *   from, to       — date range (default last 7 days)
 *   material_id    — single material drill-down
 *   only_counted   — '1' restricts to days that have a physical count
 *
 * Output is sorted by date ASC, material name ASC. Suitable for an Excel-style table.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const from = url.searchParams.get('from') || (() => { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10); })();
    const to   = url.searchParams.get('to')   || new Date().toISOString().slice(0, 10);
    const materialId = url.searchParams.get('material_id') || '';
    const onlyCounted = url.searchParams.get('only_counted') === '1';
    const outletId = await getCurrentOutletId();

    // Build the date series in JS — works across SQLite versions without recursive CTEs.
    const days: string[] = [];
    for (let d = new Date(from); d.toISOString().slice(0,10) <= to; d.setDate(d.getDate()+1)) {
      days.push(d.toISOString().slice(0,10));
    }

    // Pull all materials in scope.
    const materials = (materialId
      ? db.prepare('SELECT id, name, sku, unit, pack_size, purchase_unit, average_price FROM raw_materials WHERE id = ?').all(materialId)
      : db.prepare(`
          SELECT id, name, sku, unit, pack_size, purchase_unit, average_price
          FROM raw_materials
          WHERE id IN (
            SELECT material_id FROM purchases WHERE date BETWEEN ? AND ?
            UNION SELECT material_id FROM inventory_transactions WHERE DATE(created_at) BETWEEN ? AND ?
            UNION SELECT material_id FROM closing_stock WHERE date BETWEEN ? AND ?
          )
        `).all(from, to, from, to, from, to)
    ) as any[];

    // Per material, fetch:
    //   - opening at start of "from" (purchases before from − consumption before from)
    //   - per-day received (purchases)
    //   - per-day consumed_recipe + consumed_wastage
    //   - closing-stock counts in range
    const openingStmt = db.prepare(`
      SELECT
        COALESCE((SELECT SUM(quantity) FROM purchases WHERE material_id = ? AND date < ?), 0)
        - COALESCE((SELECT SUM(ABS(quantity)) FROM inventory_transactions
                    WHERE material_id = ? AND type IN ('sale','party','staff_meal','wastage')
                      AND DATE(created_at) < ?), 0) AS opening
    `);
    const receivedStmt = db.prepare(`
      SELECT date, COALESCE(SUM(quantity), 0) AS qty
      FROM purchases WHERE material_id = ? AND date BETWEEN ? AND ?
      GROUP BY date
    `);
    const consumedRecipeStmt = db.prepare(`
      SELECT DATE(created_at) AS date, COALESCE(SUM(ABS(quantity)), 0) AS qty
      FROM inventory_transactions
      WHERE material_id = ? AND type IN ('sale','party','staff_meal')
        AND DATE(created_at) BETWEEN ? AND ?
      GROUP BY DATE(created_at)
    `);
    const consumedWastageStmt = db.prepare(`
      SELECT DATE(created_at) AS date, COALESCE(SUM(ABS(quantity)), 0) AS qty
      FROM inventory_transactions
      WHERE material_id = ? AND type = 'wastage'
        AND DATE(created_at) BETWEEN ? AND ?
      GROUP BY DATE(created_at)
    `);
    const countStmt = db.prepare(`
      SELECT date, physical_stock FROM closing_stock
      WHERE material_id = ? AND date BETWEEN ? AND ?
    `);

    const rows: any[] = [];
    for (const m of materials) {
      const openingRow = openingStmt.get(m.id, from, m.id, from) as any;
      let running = Number(openingRow.opening) || 0;

      const recv = new Map((receivedStmt.all(m.id, from, to) as any[]).map(r => [r.date, Number(r.qty)]));
      const rcp  = new Map((consumedRecipeStmt.all(m.id, from, to) as any[]).map(r => [r.date, Number(r.qty)]));
      const wst  = new Map((consumedWastageStmt.all(m.id, from, to) as any[]).map(r => [r.date, Number(r.qty)]));
      const cnt  = new Map((countStmt.all(m.id, from, to) as any[]).map(r => [r.date, Number(r.physical_stock)]));

      for (const day of days) {
        const received = recv.get(day) || 0;
        const consumedRecipe  = rcp.get(day) || 0;
        const consumedWastage = wst.get(day) || 0;
        const consumed = consumedRecipe + consumedWastage;
        const closing  = running + received - consumed;
        const counted  = cnt.has(day) ? cnt.get(day)! : null;
        const variance = counted != null ? (closing - counted) : null;

        if (onlyCounted && counted == null) {
          running = closing; continue;
        }
        // Skip totally inactive days (no activity AND no count) to keep the report compact.
        if (received === 0 && consumed === 0 && counted == null && running === 0) {
          running = closing; continue;
        }
        rows.push({
          date: day,
          material_id: m.id, material_name: m.name, material_sku: m.sku,
          unit: m.unit, pack_size: m.pack_size, purchase_unit: m.purchase_unit,
          average_price: m.average_price,
          opening: running, received, consumed_recipe: consumedRecipe,
          consumed_wastage: consumedWastage, consumed,
          closing, counted, variance,
          loss_value: variance != null ? variance * (m.average_price || 0) : null,
        });
        running = closing;
      }
    }
    rows.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.material_name.localeCompare(b.material_name));

    // Top-line summary
    let total_loss_value = 0, days_with_count = new Set<string>();
    for (const r of rows) {
      if (r.variance != null) total_loss_value += r.loss_value || 0;
      if (r.counted != null)  days_with_count.add(r.date);
    }
    return Response.json({
      range: { from, to, days: days.length },
      summary: { rows: rows.length, days_with_count: days_with_count.size, total_loss_value },
      rows,
    });
  } catch (e: any) {
    console.error('[daily-rollup]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
