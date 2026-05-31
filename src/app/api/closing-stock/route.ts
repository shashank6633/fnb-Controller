import { getDb, generateId } from '@/lib/db';

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const date = url.searchParams.get('date');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    // Get list of closing stock dates
    if (!date && !from) {
      const dates = db.prepare(`
        SELECT DISTINCT date, COUNT(*) as item_count,
          SUM(ABS(variance_value)) as total_variance_value,
          SUM(CASE WHEN variance < 0 THEN 1 ELSE 0 END) as shortage_count,
          SUM(CASE WHEN variance > 0 THEN 1 ELSE 0 END) as excess_count
        FROM closing_stock
        GROUP BY date
        ORDER BY date DESC
        LIMIT 50
      `).all();
      return Response.json({ dates });
    }

    // Get closing stock for a specific date
    let query = `
      SELECT cs.*, rm.name as material_name, rm.unit, rm.category, rm.average_price
      FROM closing_stock cs
      JOIN raw_materials rm ON cs.material_id = rm.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (date) {
      query += ' AND cs.date = ?';
      params.push(date);
    }
    if (from) {
      query += ' AND cs.date >= ?';
      params.push(from);
    }
    if (to) {
      query += ' AND cs.date <= ?';
      params.push(to);
    }

    query += ' ORDER BY rm.category, rm.name';

    const items = db.prepare(query).all(...params);

    // Summary
    const summary = {
      total_items: items.length,
      total_system_value: (items as any[]).reduce((s, i) => s + i.system_stock * i.average_price, 0),
      total_physical_value: (items as any[]).reduce((s, i) => s + i.physical_stock * i.average_price, 0),
      total_variance_value: (items as any[]).reduce((s, i) => s + i.variance_value, 0),
      shortage_count: (items as any[]).filter(i => i.variance < 0).length,
      excess_count: (items as any[]).filter(i => i.variance > 0).length,
      match_count: (items as any[]).filter(i => i.variance === 0).length,
    };

    return Response.json({ items, summary });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    // Admin gate on `adjust_stock` — we still let store managers save counts,
    // but only admins can overwrite raw_materials.current_stock from the same
    // submit. Otherwise a store user could one-click reconcile away genuine
    // shrinkage. Counts themselves are unaffected and remain writable by all.
    const me = await (await import('@/lib/auth')).getCurrentUser();
    const isAdmin = me?.role === 'admin';
    const db = getDb();
    const body = await request.json();
    const { date, items } = body;
    const adjust_stock = isAdmin ? !!body.adjust_stock : false;

    if (!date || !items || !Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'date and items array are required' }, { status: 400 });
    }

    const results = { success: 0, errors: [] as string[] };

    const recordClosingStock = db.transaction(() => {
      // Per-material upsert (do NOT wipe the whole day — counts may arrive
      // location-by-location throughout the EOD ritual).
      const delOne = db.prepare('DELETE FROM closing_stock WHERE date = ? AND material_id = ?');

      for (const item of items) {
        if (item.material_id) delOne.run(date, item.material_id);
        if (!item.material_id) continue;

        const material = db.prepare('SELECT * FROM raw_materials WHERE id = ?').get(item.material_id) as any;
        if (!material) {
          results.errors.push(`Material not found: ${item.material_id}`);
          continue;
        }

        const systemStock = material.current_stock;
        const physicalStock = Number(item.physical_stock);

        if (isNaN(physicalStock) || physicalStock < 0) {
          results.errors.push(`Invalid physical stock for ${material.name}`);
          continue;
        }

        const variance = Math.round((physicalStock - systemStock) * 1000) / 1000;
        const varianceValue = Math.round(variance * material.average_price * 100) / 100;

        const id = generateId();

        db.prepare(`
          INSERT INTO closing_stock (id, material_id, date, system_stock, physical_stock, variance, variance_value, notes, recorded_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(id, item.material_id, date, systemStock, physicalStock, variance, varianceValue, item.notes || '', item.recorded_by || '');

        // Optionally adjust system stock to match physical count
        if (adjust_stock && variance !== 0) {
          db.prepare('UPDATE raw_materials SET current_stock = ?, updated_at = datetime(\'now\') WHERE id = ?')
            .run(physicalStock, item.material_id);

          // Log the adjustment in inventory transactions
          db.prepare(`
            INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
            VALUES (?, ?, 'adjustment', ?, ?, ?, datetime('now'))
          `).run(
            generateId(), item.material_id, variance, id,
            `Closing stock adjustment: System ${systemStock} → Physical ${physicalStock} (Variance: ${variance})`
          );
        }

        results.success++;
      }
    });

    recordClosingStock();

    return Response.json(results);
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
