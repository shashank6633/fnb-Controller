import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { emitKds } from '@/lib/kds-bus';

/**
 * POST — ask the counter print-agent to print this order's bill.
 *
 * The Captain runs on a tablet that can't reach the on-counter print bridge
 * directly, so instead of printing locally we emit a `bill.print` event on the
 * KDS bus. The print-agent page (open on the counter PC, next to the bridge)
 * picks it up over SSE and prints via its local outbox.
 *
 * Purely additive: this does NOT settle the order and the desktop POS never
 * calls it, so existing bill printing is unchanged (no double-print).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const order = db.prepare(`
      SELECT o.*, t.table_number, t.zone FROM orders o
      LEFT JOIN restaurant_tables t ON o.table_id = t.id WHERE o.id = ?
    `).get(id) as any;
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    // Don't print bills for orders that were merged away or voided (open or
    // already-settled — for a reprint — are fine).
    if (order.status === 'merged' || order.status === 'void') {
      return Response.json({ error: `This order was ${order.status} — no bill to print` }, { status: 409 });
    }
    const items = db.prepare(
      'SELECT name, quantity, unit_price, line_total FROM order_items WHERE order_id = ? ORDER BY created_at ASC'
    ).all(id) as any[];
    if (items.length === 0) return Response.json({ error: 'Order has no items' }, { status: 400 });

    // Optional target counter (multi-floor): the cashier's counter label. The
    // print-agent bound to that counter prints it; only the main/catch-all agent
    // handles an untargeted job. Empty → current single-counter behaviour.
    const b = await req.json().catch(() => ({}));
    const counter = String(b?.counter || '').trim();

    // DUPLICATE DETECTION HAPPENS HERE, and only here. The server is the one
    // place that knows whether this bill has been printed before —
    // bill_printed_at is stamped further down, so reading it now, BEFORE that
    // update, is what distinguishes press 1 from press 2. The print agent and
    // the bridge cannot work this out for themselves: an agent may have been
    // restarted, and the bridge sees only the document it is handed.
    const prevStamp = String(order.bill_printed_at || '').trim();
    const alreadyPrinted = !!prevStamp;

    // print_seq IS the bill_printed_at stamp — one value, stored, not a second
    // clock reading. It rides through to the print job id, so a deliberate
    // repeat press is a NEW job that genuinely prints.
    //
    // THE REASON IT IS THE STORED STAMP AND NOT A FRESH new Date() IS THE
    // DOUBLE-TAP. Both buttons that reach here re-enable the moment the POST
    // resolves (~100ms) — captain/order/[id] clears printingBill in its finally,
    // /cashier clears busy right after — while the paper is being cut on a
    // different machine, so nothing has visibly happened yet. A habitual 250ms
    // second tap is a second POST. With a fresh stamp per request that is two
    // job ids and two physical tax invoices from one intent; the old
    // order+total key used to absorb it, and keying on print_seq removed that
    // accident. So a press landing inside COALESCE_MS reuses the previous stamp:
    // same key, same job id, deduped at the agent — while a genuine reprint
    // minutes later still gets a fresh one and prints.
    //
    // Seconds resolution, written in SQLite's own datetime('now') shape so every
    // reader of the column (all of which only test presence) is unaffected.
    const COALESCE_MS = 6000;
    const prevMs = prevStamp
      ? Date.parse(/[TZ]|[+-]\d\d:?\d\d$/.test(prevStamp) ? prevStamp : prevStamp.replace(' ', 'T') + 'Z')
      : NaN;
    const sincePrev = Date.now() - prevMs;
    // The `>= 0` guard keeps a clock skew that puts the stamp in the future from
    // suppressing every future press instead of just the next few seconds.
    const coalesce = Number.isFinite(prevMs) && sincePrev >= 0 && sincePrev < COALESCE_MS;
    const nowStamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const printSeq = coalesce ? prevStamp : nowStamp;

    const bill = {
      id: order.id,
      order_number: order.order_number,
      // Rendered above the outlet name by the bill printer. Undefined on an
      // original, so a first bill is unchanged.
      copy_label: alreadyPrinted ? 'DUPLICATE BILL' : undefined,
      print_seq: printSeq,
      table_number: order.table_number || null,
      table_id: order.table_id || null,          // present => DINE-IN, absent => PARCEL
      zone: order.zone || null,
      order_type: order.order_type,
      covers: order.covers || 0,
      guest_name: order.guest_name || null,
      guest_mobile: order.guest_mobile || null,
      server_name: order.server_name || undefined,
      subtotal: order.subtotal, tax_total: order.tax_total, discount: order.discount, total: order.total,
      service_charge_reason: order.service_charge_reason || null,
      discount_pct: order.discount_pct || 0,
      payment_method: order.payment_method || undefined,
      items,
    };
    // Mark that a bill was printed. Two readers now depend on this:
    //  1. the cashier floor highlights "asked for the bill / about to free up";
    //  2. the NEXT press reads it to decide whether to stamp DUPLICATE BILL.
    //
    // Reader 2 is why the old `if (order.status === 'open')` guard had to go. A
    // settled order never got stamped, so every reprint after payment looked
    // like an original — and that is precisely when a guest asks for another
    // copy. Unconditional now.
    //
    // This cannot disturb reader 1: the floor highlight comes from
    // api/dine-in/tables, which joins orders ON o.status = 'open', so a settled
    // order's stamp is invisible to it by construction.
    //
    // Written explicitly rather than via datetime('now') so the stored value and
    // the print_seq above are THE SAME STRING — that identity is what makes a
    // coalesced double-tap reproduce the previous key exactly. Skipped entirely
    // while coalescing, so the window is measured from the FIRST tap of a burst
    // and cannot be extended indefinitely by further taps.
    if (!coalesce) {
      db.prepare("UPDATE orders SET bill_printed_at = ?, updated_at = datetime('now') WHERE id = ?").run(nowStamp, id);
    }

    emitKds({ type: 'bill.print', outlet_id: order.outlet_id, station: 'bill', counter, bill });
    return Response.json({ success: true, counter: counter || null });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id]/print-bill]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
