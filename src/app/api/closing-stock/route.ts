import { getDb, generateId } from '@/lib/db';

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const date = url.searchParams.get('date');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    // Department-wise scoping (2026-07):
    //   department_id — restrict to one department's counts. Special value
    //     '__store__' matches the store/overall rows (department_id NULL or '').
    //   area          — restrict to all departments in one area (kitchen/bar/…).
    const departmentId = url.searchParams.get('department_id');
    const area = url.searchParams.get('area');

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

    // Get closing stock for a specific date.
    // LEFT JOIN departments so store/overall rows (department_id NULL/'') still
    // return, and we can expose the owning department's name + area per item.
    let query = `
      SELECT cs.*, rm.name as material_name, rm.unit, rm.category, rm.average_price,
             d.name as department_name, d.area as department_area
      FROM closing_stock cs
      JOIN raw_materials rm ON cs.material_id = rm.id
      LEFT JOIN departments d ON d.id = cs.department_id
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
    if (departmentId) {
      if (departmentId === '__store__') {
        // Store / overall rows — no owning department.
        query += " AND (cs.department_id IS NULL OR cs.department_id = '')";
      } else {
        query += ' AND cs.department_id = ?';
        params.push(departmentId);
      }
    }
    if (area) {
      // All departments in the given area.
      query += ' AND d.area = ?';
      params.push(area);
    }

    query += ' ORDER BY rm.category, rm.name';

    const items = db.prepare(query).all(...params);

    // Per-area rollup of the physical closing VALUE (physical_stock × average_price).
    // Built from the SAME date/range window as `items` but WITHOUT the department_id
    // / area filters, so admins always see every area's total even when they've
    // drilled into one department. Rows with no owning department roll up under
    // the '__store__' bucket. Kept as its own aggregate query for correctness.
    const rollupParams: any[] = [];
    let rollupWhere = 'WHERE 1=1';
    if (date) { rollupWhere += ' AND cs.date = ?'; rollupParams.push(date); }
    if (from) { rollupWhere += ' AND cs.date >= ?'; rollupParams.push(from); }
    if (to)   { rollupWhere += ' AND cs.date <= ?'; rollupParams.push(to); }
    const areaRows = db.prepare(`
      SELECT COALESCE(NULLIF(d.area, ''), '__store__') AS area,
             SUM(cs.physical_stock * rm.average_price)  AS physical_value,
             SUM(cs.system_stock   * rm.average_price)  AS system_value,
             SUM(cs.variance_value)                     AS variance_value,
             COUNT(*)                                   AS item_count
      FROM closing_stock cs
      JOIN raw_materials rm ON cs.material_id = rm.id
      LEFT JOIN departments d ON d.id = cs.department_id
      ${rollupWhere}
      GROUP BY COALESCE(NULLIF(d.area, ''), '__store__')
      ORDER BY area
    `).all(...rollupParams) as any[];
    const by_area = areaRows.map(r => ({
      area: r.area,
      physical_value: r.physical_value || 0,
      system_value: r.system_value || 0,
      variance_value: r.variance_value || 0,
      item_count: r.item_count || 0,
    }));

    // Summary
    const summary = {
      total_items: items.length,
      total_system_value: (items as any[]).reduce((s, i) => s + i.system_stock * i.average_price, 0),
      total_physical_value: (items as any[]).reduce((s, i) => s + i.physical_stock * i.average_price, 0),
      total_variance_value: (items as any[]).reduce((s, i) => s + i.variance_value, 0),
      shortage_count: (items as any[]).filter(i => i.variance < 0).length,
      excess_count: (items as any[]).filter(i => i.variance > 0).length,
      match_count: (items as any[]).filter(i => i.variance === 0).length,
      by_area,
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
    // Department-wise counts (2026-07): a top-level department_id applies to every
    // item unless the item carries its own. Normalize '' / null / '__store__' to
    // NULL so store/overall counts (no owning department) are stored consistently.
    const normDept = (v: any): string | null => {
      const s = v == null ? '' : String(v).trim();
      return s === '' || s === '__store__' ? null : s;
    };
    const topDeptId = normDept(body.department_id);

    if (!date || !items || !Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'date and items array are required' }, { status: 400 });
    }

    const results = { success: 0, errors: [] as string[] };

    const recordClosingStock = db.transaction(() => {
      // Per-(material, department) upsert (do NOT wipe the whole day — counts may
      // arrive department-by-department / location-by-location throughout the EOD
      // ritual). The delete is scoped by department_id so saving one department's
      // count never clobbers another department's count of the same material.
      const delOne = db.prepare(
        "DELETE FROM closing_stock WHERE date = ? AND material_id = ? AND COALESCE(department_id, '') = COALESCE(?, '')"
      );

      for (const item of items) {
        if (!item.material_id) continue;
        // Per-item department_id overrides the top-level one when present.
        const deptId = item.department_id !== undefined ? normDept(item.department_id) : topDeptId;
        delOne.run(date, item.material_id, deptId);

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
          INSERT INTO closing_stock (id, material_id, department_id, date, system_stock, physical_stock, variance, variance_value, notes, recorded_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(id, item.material_id, deptId, date, systemStock, physicalStock, variance, varianceValue, item.notes || '', item.recorded_by || '');

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
