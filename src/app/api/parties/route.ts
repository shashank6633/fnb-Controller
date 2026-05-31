import { getDb, generateId } from '@/lib/db';

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    let query = `
      SELECT p.*, p.akan_unique_id, p.akan_host_name, p.akan_company, p.akan_phone, p.akan_occasion, p.akan_package, p.akan_final_amount,
        COALESCE(pi.total_items, 0) as total_items,
        COALESCE(pi.total_cost, 0) as consumption_cost,
        COALESCE(pi.total_revenue, 0) as consumption_revenue,
        COALESCE(pi.beverage_cost, 0) as beverage_cost,
        COALESCE(pi.liquor_cost, 0) as liquor_cost,
        COALESCE(pi.food_cost, 0) as food_cost,
        COALESCE(pi.comp_cost, 0) as complimentary_cost
      FROM parties p
      LEFT JOIN (
        SELECT party_id,
          COUNT(*) as total_items,
          SUM(total_cost) as total_cost,
          SUM(total_revenue) as total_revenue,
          SUM(CASE WHEN category IN ('beverage', 'mixer') THEN total_cost ELSE 0 END) as beverage_cost,
          SUM(CASE WHEN category = 'liquor' THEN total_cost ELSE 0 END) as liquor_cost,
          SUM(CASE WHEN category = 'food' THEN total_cost ELSE 0 END) as food_cost,
          SUM(CASE WHEN is_complimentary = 1 THEN total_cost ELSE 0 END) as comp_cost
        FROM party_items
        GROUP BY party_id
      ) pi ON pi.party_id = p.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (status) {
      query += ' AND p.status = ?';
      params.push(status);
    }
    if (from) {
      query += ' AND p.date >= ?';
      params.push(from);
    }
    if (to) {
      query += ' AND p.date <= ?';
      params.push(to);
    }

    query += ' ORDER BY p.date DESC, p.created_at DESC';

    const parties = db.prepare(query).all(...params);
    return Response.json({ parties });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { name, date, party_type, venue, floor, guest_count, status, notes } = body;

    if (!name || !date) {
      return Response.json({ error: 'name and date are required' }, { status: 400 });
    }

    const id = generateId();

    db.prepare(`
      INSERT INTO parties (id, name, date, party_type, venue, floor, guest_count, status, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(id, name, date, party_type || 'mixed', venue || '', floor || '', guest_count || 0, status || 'upcoming', notes || '');

    const party = db.prepare('SELECT * FROM parties WHERE id = ?').get(id);
    return Response.json({ party }, { status: 201 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { id, name, date, party_type, venue, floor, guest_count, status, notes } = body;

    if (!id) {
      return Response.json({ error: 'id is required' }, { status: 400 });
    }

    db.prepare(`
      UPDATE parties SET
        name = COALESCE(?, name),
        date = COALESCE(?, date),
        party_type = COALESCE(?, party_type),
        venue = COALESCE(?, venue),
        floor = COALESCE(?, floor),
        guest_count = COALESCE(?, guest_count),
        status = COALESCE(?, status),
        notes = COALESCE(?, notes),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(name, date, party_type, venue, floor, guest_count, status, notes, id);

    const party = db.prepare('SELECT * FROM parties WHERE id = ?').get(id);
    return Response.json({ party });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const id = url.searchParams.get('id');

    if (!id) {
      return Response.json({ error: 'id is required' }, { status: 400 });
    }

    db.prepare('DELETE FROM party_items WHERE party_id = ?').run(id);
    db.prepare('DELETE FROM parties WHERE id = ?').run(id);

    return Response.json({ success: true });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
