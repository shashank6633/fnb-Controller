import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canDownloadBillCopy, BILL_COPY_REFUSED_MESSAGE } from '@/lib/bill-copy-access';
import { buildBillPdf } from '@/lib/bill-pdf';

/**
 * GET /api/dine-in/orders/[id]/bill-pdf — download a digital copy of the bill as
 * an 80mm PDF, identical to the printed thermal bill (same computeBill + the same
 * bill_design branding). For open orders it's a provisional bill; for settled
 * orders it's stamped DUPLICATE BILL (a reprint).
 *
 * THE GATE: canDownloadBillCopy() — see src/lib/bill-copy-access.ts for the whole
 * argument. It replaced canApproveTableOp(), which admitted admin/manager on TIER
 * but a cashier only on `role_name === 'Cashier'`; role_id is NULL on all nine
 * users on the owner's database, so role_name resolves for nobody and a cashier
 * could never reprint a bill. canApproveTableOp itself is UNCHANGED — its five
 * other callers (service-charge waiver, discount approval, transfer/merge,
 * discount requests) are money and authority decisions that must stay tight.
 *
 * THE OUTLET SCOPE: the lookup below carries the SAME predicate the order LIST
 * uses — `(o.outlet_id = ? OR o.outlet_id IS NULL)` from getCurrentOutletId()
 * (api/dine-in/orders/route.ts:15-16) — so this endpoint hands back a copy of a
 * bill the caller can already see on their own screen, and nothing else. That
 * sentence is the whole safety argument for widening the gate (see
 * bill-copy-access.ts) and it is only TRUE with this predicate: without it the
 * lookup was a bare `WHERE o.id = ?`, so a till user pinned to Branch 2 could
 * pull a Main bill — a guest name, a mobile number and a total for an outlet
 * their own order list refuses to show them. MEASURED on the owner's database
 * (2026-09-19): all 9 users sit on Main and all 37 orders are Main's, so this
 * predicate changes nothing today; it is what keeps the second outlet separate
 * the day it is used.
 *
 * An out-of-outlet id answers 'Order not found' (404), deliberately identical to
 * a genuinely unknown id: distinguishing them would turn this route into an
 * oracle for which order ids exist elsewhere. An admin who does need another
 * outlet's bill switches outlet, exactly as they must to see it in any list.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canDownloadBillCopy(me)) return Response.json({ error: BILL_COPY_REFUSED_MESSAGE }, { status: 403 });
    const { id } = await params;
    const db = getDb();
    // Same outlet scope as the order list this copy is taken from. `outletId` is
    // passed even when it resolves null, exactly as the list route passes it, so
    // the two surfaces can never disagree about what is visible.
    const outletId = await getCurrentOutletId();

    const order = db.prepare(`
      SELECT o.*, t.table_number, t.zone
      FROM orders o LEFT JOIN restaurant_tables t ON o.table_id = t.id
      WHERE o.id = ? AND (o.outlet_id = ? OR o.outlet_id IS NULL)
    `).get(id, outletId) as any;
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    if (order.status === 'void' || order.status === 'merged') {
      return Response.json({ error: `This order was ${order.status} — no bill` }, { status: 409 });
    }
    const items = db.prepare(
      'SELECT name, quantity, unit_price, line_total, tax_value FROM order_items WHERE order_id = ? ORDER BY created_at ASC'
    ).all(id) as any[];
    if (items.length === 0) return Response.json({ error: 'Order has no items' }, { status: 400 });

    // Same settings the thermal print + settle read.
    const settings = db.prepare('SELECT key, value FROM settings').all() as any[];
    const get = (k: string) => settings.find((s) => s.key === k)?.value;
    let design: any = {};
    try { design = JSON.parse(get('bill_design') || '{}') || {}; } catch { design = {}; }

    // Split tenders (cash/upi/…) for a settled bill so the copy itemises them.
    const payments = order.status === 'settled'
      ? (db.prepare('SELECT method, amount FROM order_payments WHERE order_id = ? ORDER BY created_at').all(id) as any[])
      : [];

    const pdf = await buildBillPdf(order, items, design, {
      businessName: get('business_name') || 'Restaurant',
      gstin: get('gstin') || '',
      printedBy: me.name || me.email || '',
      // A HELD BILL IS A REPRINT TOO. 'on_hold' means the bill was finalised and
      // presented — hold froze the totals and the POS refuses to add another
      // item to it — so anything pulled from this endpoint afterwards is a copy,
      // including the "Download / reprint" on a Bills-on-Hold record. Left as
      // `=== 'settled'` it came off the printer as an unmarked ORIGINAL, which
      // is the exact defect this project has already shipped once (see
      // project_fnb_print_topology). Over-marking a first copy is cosmetic;
      // under-marking a second original is not.
      duplicate: order.status === 'settled' || order.status === 'on_hold',
      payments,
    });

    const fname = `bill-${order.order_number || id}.pdf`;
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${fname}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id]/bill-pdf GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
