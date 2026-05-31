import { getDb } from '@/lib/db';
import { currentRole } from '@/app/api/purchase-orders/route';

// Manager OR Admin can submit a draft for approval.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    const po = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
    if (po.status !== 'draft') return Response.json({ error: `Only drafts can be submitted (current: ${po.status})` }, { status: 400 });

    const items = db.prepare('SELECT COUNT(*) AS n FROM purchase_order_items WHERE po_id = ?').get(id) as any;
    if (items.n === 0) return Response.json({ error: 'Cannot submit empty PO — add at least one item' }, { status: 400 });

    db.prepare(`
      UPDATE purchase_orders SET status = 'pending', submitted_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
    return Response.json({ success: true, status: 'pending' });
  } catch (e: any) { return Response.json({ error: e.message }, { status: 500 }); }
}
