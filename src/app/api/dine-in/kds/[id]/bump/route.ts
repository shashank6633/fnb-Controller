import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { emitKds } from '@/lib/kds-bus';

const FLOW = ['new', 'preparing', 'ready', 'served'];

/**
 * POST — advance a KOT one step along new → preparing → ready → served. Body may
 * pass { to } to set a specific status; otherwise it advances by one. On 'served'
 * the ticket drops off the active board. Broadcasts a kot.bumped event.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const kot = db.prepare('SELECT * FROM kots WHERE id = ?').get(id) as any;
    if (!kot) return Response.json({ error: 'KOT not found' }, { status: 404 });

    const b = await req.json().catch(() => ({}));
    let next: string;
    if (b.to && FLOW.includes(b.to)) {
      next = b.to;
    } else {
      const i = FLOW.indexOf(kot.status);
      next = FLOW[Math.min(i + 1, FLOW.length - 1)];
    }
    if (next === kot.status) return Response.json({ status: next, kot });

    db.prepare("UPDATE kots SET status = ?, updated_at = datetime('now') WHERE id = ?").run(next, id);
    // When the whole ticket is done, mark its items served too.
    if (next === 'served') {
      db.prepare("UPDATE order_items SET status = 'served' WHERE kot_id = ?").run(id);
    }

    emitKds({ type: 'kot.bumped', outlet_id: kot.outlet_id, station: kot.station, kot: { id, status: next, order_id: kot.order_id } });
    return Response.json({ status: next });
  } catch (e: any) {
    console.error('[/api/dine-in/kds/[id]/bump]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
