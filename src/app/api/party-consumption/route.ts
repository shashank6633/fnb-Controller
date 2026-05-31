import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Post-party liquor / beverage consumption.
 *
 * Bar manager records bottle counts after the event. Cost is snapshotted
 * at recording time from raw_materials.average_price so historical P&L
 * doesn't drift when stock prices move.
 *
 * GET    /api/party-consumption?party_unique_id=...
 * GET    /api/party-consumption?event_name=...&event_date=YYYY-MM-DD
 * POST   /api/party-consumption
 *        body: { party_unique_id?, fp_id?, event_name, event_date,
 *                items: [{ material_id, qty, notes? }] }
 * DELETE /api/party-consumption?id=<uuid>
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const url = new URL(request.url);
    const partyUniqueId = url.searchParams.get('party_unique_id');
    const eventName     = url.searchParams.get('event_name');
    const eventDate     = url.searchParams.get('event_date');

    let rows;
    if (partyUniqueId) {
      rows = db.prepare(`
        SELECT pc.*, rm.name AS material_name, rm.unit AS material_unit,
               rm.average_price AS current_avg_price
        FROM party_consumption pc
        JOIN raw_materials rm ON rm.id = pc.material_id
        WHERE pc.party_unique_id = ?
        ORDER BY pc.recorded_at DESC
      `).all(partyUniqueId);
    } else if (eventName && eventDate) {
      rows = db.prepare(`
        SELECT pc.*, rm.name AS material_name, rm.unit AS material_unit,
               rm.average_price AS current_avg_price
        FROM party_consumption pc
        JOIN raw_materials rm ON rm.id = pc.material_id
        WHERE pc.event_name = ? AND pc.event_date = ?
        ORDER BY pc.recorded_at DESC
      `).all(eventName, eventDate);
    } else {
      return Response.json({ error: 'party_unique_id or (event_name+event_date) required' }, { status: 400 });
    }
    return Response.json({ entries: rows });
  } catch (e: any) {
    console.error('[/api/party-consumption GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const b = await request.json();
    const { party_unique_id, fp_id, event_name, event_date, items } = b;

    if (!event_name || !String(event_name).trim()) {
      return Response.json({ error: 'event_name required' }, { status: 400 });
    }
    if (!event_date || !String(event_date).match(/^\d{4}-\d{2}-\d{2}$/)) {
      return Response.json({ error: 'event_date (YYYY-MM-DD) required' }, { status: 400 });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'items required' }, { status: 400 });
    }

    const ins = db.prepare(`
      INSERT INTO party_consumption
        (id, party_unique_id, fp_id, event_name, event_date,
         material_id, qty_consumed, cost_at_time, notes, recorded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const getMat = db.prepare(`SELECT average_price FROM raw_materials WHERE id = ?`);

    const txn = db.transaction(() => {
      for (const it of items) {
        const qty = Number(it.qty) || 0;
        if (!it.material_id || qty <= 0) continue;
        const mat = getMat.get(it.material_id) as { average_price?: number } | undefined;
        const cost = (mat?.average_price || 0) * qty;
        ins.run(
          generateId(),
          party_unique_id || null,
          fp_id || null,
          String(event_name).trim(),
          event_date,
          it.material_id,
          qty,
          cost,
          it.notes || '',
          me.email,
        );
      }
    });
    txn();
    return Response.json({ success: true }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/party-consumption POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    const row = db.prepare('SELECT * FROM party_consumption WHERE id = ?').get(id) as any;
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 });
    if (row.recorded_by !== me.email && me.role !== 'admin') {
      return Response.json({ error: 'Only the recorder or admin can delete' }, { status: 403 });
    }
    db.prepare('DELETE FROM party_consumption WHERE id = ?').run(id);
    return Response.json({ success: true });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
