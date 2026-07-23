import { getDb } from '@/lib/db';
import { resolveTableByToken } from '@/lib/customer';

/**
 * GET /api/customer/table-party?t=<qr_token>   (PUBLIC — table-token scoped)
 *
 * A 2nd/3rd scanner's QR menu asks this to show a "join this table?" prompt
 * naming the party's registered member. We return ONLY a recognition cue — the
 * primary's name and the LAST 4 digits of their number — NEVER the full number
 * (privacy; the real session link is the table, not the digits).
 *
 * Resolution mirrors /api/customer/orders (token → table). The primary is the
 * table's active order (open preferred, else earliest pending_approval), read
 * from order_guests (is_primary=1) or falling back to the order's guest_name /
 * guest_mobile.
 *
 * Response: { ok, has_primary, primary_name, primary_last4 }
 *   has_primary=false when the table has no active session (or no identity yet).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get('t') || url.searchParams.get('table') || '';
    const table = resolveTableByToken(token);
    if (!table) return Response.json({ ok: false, error: 'Unknown table.' }, { status: 404 });

    const db = getDb();
    const empty = { ok: true, has_primary: false, primary_name: '', primary_last4: '' };

    // The table's active session: prefer a live OPEN bill, else the earliest
    // pending_approval staging order.
    const order = db.prepare(`
      SELECT id, guest_name, guest_mobile FROM orders
      WHERE table_id = ? AND status IN ('open','pending_approval')
      ORDER BY (status = 'open') DESC, created_at ASC LIMIT 1
    `).get(table.id) as any;
    if (!order) return Response.json(empty, { headers: { 'Cache-Control': 'no-store' } });

    // Primary = the explicit order_guests primary, else the order's own guest.
    const primary = db.prepare(
      'SELECT name, mobile FROM order_guests WHERE order_id = ? AND is_primary = 1 LIMIT 1',
    ).get(order.id) as any;

    let name = '', mobile = '';
    if (primary) { name = String(primary.name || '').trim(); mobile = String(primary.mobile || ''); }
    else { name = String(order.guest_name || '').trim(); mobile = String(order.guest_mobile || ''); }

    const last4 = mobile.replace(/\D/g, '').slice(-4);   // recognition cue only — never the full number
    const hasPrimary = !!(name || last4);

    return Response.json({
      ok: true,
      has_primary: hasPrimary,
      primary_name: hasPrimary ? name : '',
      primary_last4: hasPrimary ? last4 : '',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    console.error('[/api/customer/table-party GET]', e);
    return Response.json({ ok: false, error: 'Could not load table party.' }, { status: 500 });
  }
}
