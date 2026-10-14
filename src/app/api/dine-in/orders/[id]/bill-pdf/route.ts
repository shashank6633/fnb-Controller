import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canDownloadBillCopy, BILL_COPY_REFUSED_MESSAGE } from '@/lib/bill-copy-access';
import { buildBillPdf } from '@/lib/bill-pdf';

/**
 * GET /api/dine-in/orders/[id]/bill-pdf — download a digital copy of the bill as
 * an 80mm PDF, identical to the printed thermal bill (same computeBill + the same
 * bill_design branding). For open orders it's a provisional bill; for settled
 * orders it's stamped DUPLICATE BILL (a reprint).
 *
 * THE GATE: canDownloadBillCopy() — the Cashier role, manager or admin; plain
 * staff are refused. See src/lib/bill-copy-access.ts. It is production's own
 * canApproveTableOp() (admin / manager tier, or the assigned role named
 * 'Cashier'), called unchanged, so exactly the logins production admitted are
 * admitted. A page map — NULL, empty or even an explicit '/cashier' grant — is
 * never a pass by itself; only the Cashier role is.
 *
 * THE LOOKUP is production's, unchanged: by order id alone, with no outlet
 * filter. The 2026-10-14 approval names WHO may download a copy and the
 * one-page trim — not an outlet scope — so a caller whose current outlet
 * differs from the bill's still gets the copy, exactly as before.
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

    const order = db.prepare(`
      SELECT o.*, t.table_number, t.zone
      FROM orders o LEFT JOIN restaurant_tables t ON o.table_id = t.id
      WHERE o.id = ?
    `).get(id) as any;
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
