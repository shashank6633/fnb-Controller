import { getDb, generateId } from '@/lib/db';

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const status = url.searchParams.get('status');

    let query = `
      SELECT sm.*,
        COALESCE(smi.total_items, 0) as total_items,
        COALESCE(smi.total_issued_value, 0) as total_issued_value,
        COALESCE(smi.total_returned_value, 0) as total_returned_value,
        COALESCE(smi.total_consumed_cost, 0) as total_consumed_cost,
        COALESCE(smi.open_items, 0) as open_items,
        COALESCE(smi.closed_items, 0) as closed_items
      FROM staff_meals sm
      LEFT JOIN (
        SELECT meal_id,
          COUNT(*) as total_items,
          SUM(issued_quantity * purchase_price) as total_issued_value,
          SUM(returned_quantity * purchase_price) as total_returned_value,
          SUM(total_cost) as total_consumed_cost,
          SUM(CASE WHEN status = 'issued' THEN 1 ELSE 0 END) as open_items,
          SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_items
        FROM staff_meal_items
        GROUP BY meal_id
      ) smi ON smi.meal_id = sm.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (from) { query += ' AND sm.date >= ?'; params.push(from); }
    if (to) { query += ' AND sm.date <= ?'; params.push(to); }
    if (status) { query += ' AND sm.status = ?'; params.push(status); }

    query += ' ORDER BY sm.date DESC, sm.created_at DESC';

    const meals = db.prepare(query).all(...params);

    // Summary for top cards
    const summary = db.prepare(`
      SELECT
        COUNT(*) as total_meals,
        COALESCE(SUM(staff_count), 0) as total_staff_fed,
        COALESCE(SUM(smi.total_consumed_cost), 0) as total_cost
      FROM staff_meals sm
      LEFT JOIN (
        SELECT meal_id, SUM(total_cost) as total_consumed_cost
        FROM staff_meal_items GROUP BY meal_id
      ) smi ON smi.meal_id = sm.id
    `).get();

    return Response.json({ meals, summary });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { date, meal_type, shift, staff_count, cooked_by, menu, notes } = body;

    if (!date || !meal_type) {
      return Response.json({ error: 'date and meal_type are required' }, { status: 400 });
    }

    const id = generateId();
    db.prepare(`
      INSERT INTO staff_meals (id, date, meal_type, shift, staff_count, cooked_by, menu, status, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, datetime('now'), datetime('now'))
    `).run(id, date, meal_type, shift || '', staff_count || 0, cooked_by || '', menu || '', notes || '');

    const meal = db.prepare('SELECT * FROM staff_meals WHERE id = ?').get(id);
    return Response.json({ meal }, { status: 201 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { id, date, meal_type, shift, staff_count, cooked_by, menu, status, notes } = body;

    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

    db.prepare(`
      UPDATE staff_meals SET
        date = COALESCE(?, date),
        meal_type = COALESCE(?, meal_type),
        shift = COALESCE(?, shift),
        staff_count = COALESCE(?, staff_count),
        cooked_by = COALESCE(?, cooked_by),
        menu = COALESCE(?, menu),
        status = COALESCE(?, status),
        notes = COALESCE(?, notes),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(date, meal_type, shift, staff_count, cooked_by, menu, status, notes, id);

    const meal = db.prepare('SELECT * FROM staff_meals WHERE id = ?').get(id);
    return Response.json({ meal });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

    // Restore any open items' stock before deletion
    const items = db.prepare("SELECT * FROM staff_meal_items WHERE meal_id = ? AND status = 'issued'").all(id) as any[];
    for (const item of items) {
      if (item.material_id) {
        const netRemoved = item.issued_quantity - item.returned_quantity;
        if (netRemoved > 0) {
          db.prepare('UPDATE raw_materials SET current_stock = current_stock + ? WHERE id = ?')
            .run(netRemoved, item.material_id);
          db.prepare(`
            INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
            VALUES (?, ?, 'adjustment', ?, ?, ?, datetime('now'))
          `).run(generateId(), item.material_id, netRemoved, item.id, `Staff meal deleted — stock restored`);
        }
      }
    }

    db.prepare('DELETE FROM staff_meal_items WHERE meal_id = ?').run(id);
    db.prepare('DELETE FROM staff_meals WHERE id = ?').run(id);
    return Response.json({ success: true });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
