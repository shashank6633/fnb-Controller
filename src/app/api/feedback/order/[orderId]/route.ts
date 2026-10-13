/**
 * GET /api/feedback/order/[orderId] — the ordered items for ONE table.  (P2 Lane A)
 *
 * The owner's constraint: a GRE "may view ordered items" but has READ-ONLY
 * ACCESS. This is that view, and it is THE MODULE'S OWN NARROW READ — never a
 * proxy to, nor a re-export of, a POS route.
 *
 * WHY THAT MATTERS RATHER THAN BEING TIDINESS. The obvious shortcut would be to
 * call `GET /api/dine-in/orders/[id]`. That is the SAME FILE that exports
 * `PATCH`, whose entire authorisation is `if (!me) return 401` and whose
 * actions include add_item · set_qty · remove_item · fire. Re-exporting or
 * forwarding that handler would put four of the six forbidden powers one
 * careless edit away from the GRE's own module. So this route reads
 * `order_items` directly, through `readOrderForFeedback()`, which is `SELECT`-
 * only — and it returns NO MONEY at all: no unit price, no line total, no
 * discount, no bill. A read that cannot see a price cannot leak one, and the
 * GRE is recording how the food was, not auditing the cheque.
 *
 * 🔒 `GET` is the only export. Every other verb is 405 by construction.
 */

import { getDb } from '@/lib/db';
import { getCurrentOutletId } from '@/lib/auth';
import { requireFeedbackReader } from '@/lib/feedback/session';
import { readOrderForFeedback } from '@/lib/feedback/read';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const gate = await requireFeedbackReader();
  if (!gate.ok) return Response.json(gate.body, { status: gate.status });

  try {
    const { orderId } = await params;
    const id = String(orderId ?? '').trim();
    if (!id) return Response.json({ error: 'orderId is required' }, { status: 400 });

    const db = getDb();
    const outletId = await getCurrentOutletId();
    const view = readOrderForFeedback(db, id, outletId);
    // A voided order, another outlet's order and a typo'd id are one answer on
    // purpose: nothing here should let a caller probe which order ids exist.
    if (!view) return Response.json({ error: 'Order not found' }, { status: 404 });

    return Response.json({ order: view });
  } catch (e: any) {
    console.error('[/api/feedback/order/[orderId] GET]', e);
    return Response.json({ error: e?.message || 'Failed to load the order' }, { status: 500 });
  }
}
