import { getDb, generateId } from '@/lib/db';

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    const search = url.searchParams.get('search') || '';
    const includeStats = url.searchParams.get('stats') === '1';

    if (id) {
      const v = db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
      return Response.json({ vendor: v });
    }

    const where = search ? `WHERE v.name LIKE ?` : '';
    const params = search ? [`%${search}%`] : [];

    if (includeStats) {
      const rows = db.prepare(`
        SELECT v.*,
               (SELECT COUNT(*) FROM purchase_orders po WHERE po.vendor_id = v.id) AS po_count,
               (SELECT COALESCE(SUM(total_cost), 0) FROM purchase_orders po
                WHERE po.vendor_id = v.id AND po.status IN ('approved', 'received')) AS lifetime_spend,
               (SELECT MAX(date) FROM purchase_orders po WHERE po.vendor_id = v.id AND po.status = 'received') AS last_received
        FROM vendors v
        ${where}
        ORDER BY v.name ASC
      `).all(...params);
      return Response.json({ vendors: rows });
    }

    const rows = db.prepare(`SELECT * FROM vendors ${where} ORDER BY name ASC`).all(...params);
    return Response.json({ vendors: rows });
  } catch (e: any) { return Response.json({ error: e.message }, { status: 500 }); }
}

export async function POST(request: Request) {
  try {
    const db = getDb();
    const b = await request.json();
    if (!b.name) return Response.json({ error: 'name required' }, { status: 400 });
    const id = generateId();
    db.prepare(`
      INSERT INTO vendors (id, name, contact_person, phone, email, gstin, address, payment_terms, lead_time_days, is_active, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, b.name, b.contact_person || '', b.phone || '', b.email || '', b.gstin || '',
            b.address || '', b.payment_terms || '', Number(b.lead_time_days) || 0,
            b.is_active === false ? 0 : 1, b.notes || '');
    const v = db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
    return Response.json({ vendor: v }, { status: 201 });
  } catch (e: any) { return Response.json({ error: e.message }, { status: 500 }); }
}

export async function PUT(request: Request) {
  try {
    const db = getDb();
    const b = await request.json();
    if (!b.id) return Response.json({ error: 'id required' }, { status: 400 });
    db.prepare(`
      UPDATE vendors SET
        name = COALESCE(?, name),
        contact_person = COALESCE(?, contact_person),
        phone = COALESCE(?, phone),
        email = COALESCE(?, email),
        gstin = COALESCE(?, gstin),
        address = COALESCE(?, address),
        payment_terms = COALESCE(?, payment_terms),
        lead_time_days = COALESCE(?, lead_time_days),
        is_active = COALESCE(?, is_active),
        notes = COALESCE(?, notes),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.name ?? null, b.contact_person ?? null, b.phone ?? null, b.email ?? null,
      b.gstin ?? null, b.address ?? null, b.payment_terms ?? null,
      b.lead_time_days != null ? Number(b.lead_time_days) : null,
      b.is_active != null ? (b.is_active ? 1 : 0) : null,
      b.notes ?? null, b.id,
    );
    const v = db.prepare('SELECT * FROM vendors WHERE id = ?').get(b.id);
    return Response.json({ vendor: v });
  } catch (e: any) { return Response.json({ error: e.message }, { status: 500 }); }
}

export async function DELETE(request: Request) {
  try {
    const db = getDb();
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    // Soft delete — preserve history
    db.prepare(`UPDATE vendors SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
    return Response.json({ success: true });
  } catch (e: any) { return Response.json({ error: e.message }, { status: 500 }); }
}
