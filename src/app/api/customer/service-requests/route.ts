import { getDb, generateId } from '@/lib/db';
import { resolveTableByToken } from '@/lib/customer';

const VALID_TYPES = new Set(['waiter', 'water', 'cutlery', 'bill']);

/**
 * POST /api/customer/service-requests   (PUBLIC — table-token scoped)
 *
 * The guest taps a Table-assistance action (Call waiter / Refill water / Extra
 * cutlery / Request bill). Lands as a 'pending' service_request for the Captain
 * dashboard. De-duplicated: re-tapping the same still-pending action returns the
 * existing request instead of spamming the dashboard.
 *
 * Body: { t: <qr_token>, type: 'waiter'|'water'|'cutlery'|'bill', note?: string }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const token = String(body?.t || body?.table || '').trim();
    const table = resolveTableByToken(token);
    if (!table) return Response.json({ ok: false, error: 'Unknown table.' }, { status: 404 });

    const type = String(body?.type || '').toLowerCase().trim();
    if (!VALID_TYPES.has(type)) return Response.json({ ok: false, error: 'Unknown request type.' }, { status: 400 });

    const db = getDb();
    // De-dupe: an unresolved (pending/accepted) request of the same type on this
    // table shouldn't be duplicated by a double-tap.
    const existing = db.prepare(`
      SELECT id, status FROM service_requests
      WHERE table_id = ? AND type = ? AND status IN ('pending','accepted')
      ORDER BY created_at DESC LIMIT 1
    `).get(table.id, type) as any;
    if (existing) {
      return Response.json({ ok: true, id: existing.id, type, status: existing.status, deduped: true });
    }

    const id = generateId();
    db.prepare(`
      INSERT INTO service_requests (id, outlet_id, table_id, table_number, type, status, note, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, datetime('now'))
    `).run(id, table.outlet_id, table.id, table.table_number, type, String(body?.note || '').slice(0, 200));

    return Response.json({ ok: true, id, type, status: 'pending' });
  } catch (e: any) {
    console.error('[/api/customer/service-requests POST]', e);
    return Response.json({ ok: false, error: 'Could not send your request.' }, { status: 500 });
  }
}

/**
 * GET /api/customer/service-requests?t=<qr_token>   (PUBLIC)
 * The table's requests from the last couple of hours + their status.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get('t') || url.searchParams.get('table') || '';
    const table = resolveTableByToken(token);
    if (!table) return Response.json({ ok: false, error: 'Unknown table.' }, { status: 404 });

    const db = getDb();
    const rows = db.prepare(`
      SELECT id, type, status, created_at, accepted_at, completed_at
      FROM service_requests
      WHERE table_id = ? AND created_at > datetime('now','-2 hours')
      ORDER BY created_at DESC
    `).all(table.id) as any[];

    return Response.json({ ok: true, requests: rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    console.error('[/api/customer/service-requests GET]', e);
    return Response.json({ ok: false, error: 'Could not load requests.' }, { status: 500 });
  }
}
