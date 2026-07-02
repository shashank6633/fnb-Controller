import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

// Manager OR Admin: cancel a draft / pending PO. Approved/Received cannot be cancelled (use refund flow instead).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    if (!(await getCurrentUser())) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const po = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
    if (!['draft', 'pending', 'rejected'].includes(po.status)) {
      return Response.json({ error: `Cannot cancel ${po.status} PO` }, { status: 400 });
    }
    db.prepare(`UPDATE purchase_orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(id);
    return Response.json({ success: true, status: 'cancelled' });
  } catch (e: any) { return Response.json({ error: e.message }, { status: 500 }); }
}
