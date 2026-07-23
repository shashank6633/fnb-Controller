import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { addOrderGuest, listOrderGuests } from '@/lib/ct/seating';

/**
 * Table party / guest list for ONE order (Part B — multi-guest capture).
 *
 *   GET  /api/dine-in/orders/[id]/guests            (auth) → { guests: [...] }
 *   POST /api/dine-in/orders/[id]/guests            (auth) → { guests: [...] }
 *     body { mobile?, name?, is_primary? } → append/update one diner.
 *
 * addOrderGuest is idempotent per (order, phone), never overwrites the primary
 * unless is_primary is set, and mirrors each number into the CRM (guest +
 * dining visit). listOrderGuests returns the party primary-first.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(id) as any;
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    return Response.json({ guests: listOrderGuests(db, id) });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id]/guests GET]', e);
    return Response.json({ error: e?.message || 'Failed to load party' }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(id) as any;
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });

    const b = await req.json().catch(() => ({}));
    addOrderGuest(db, {
      orderId: id,
      mobile: b?.mobile,
      name: b?.name,
      isPrimary: !!b?.is_primary,
      source: 'walk-in',
    });
    return Response.json({ guests: listOrderGuests(db, id) });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id]/guests POST]', e);
    return Response.json({ error: e?.message || 'Failed to add guest' }, { status: 500 });
  }
}
