import { getDb, recordSale } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, canApproveTableOp } from '@/lib/auth';
import { canWorkTable } from '@/lib/captain-area';
import { todayIST } from '@/lib/format-date';
import { computeBill, sumItemTax } from '@/lib/bill-calc';
import { resolveFloorStore } from '@/lib/store-engine';

/**
 * POST /api/dine-in/orders/[id]/hold — park a finalised bill as UNPAID.
 *
 * Like settle, but records NO payment: it writes the `sales` rows (revenue +
 * inventory), stores the authoritative totals and flips the order to 'on_hold'
 * so the table frees and the amount shows under the cashier's Outstanding
 * Payment tab. Payment is collected later via settle (which accepts on_hold).
 * Gated exactly like settle (cashier/manager/admin, or a captain on their table).
 */
function loadBillDesign(db: ReturnType<typeof getDb>) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'bill_design'").get() as any;
  let d: any = {};
  if (row?.value) { try { d = JSON.parse(row.value) || {}; } catch { d = {}; } }
  return {
    serviceChargeOn: d.serviceChargeOn !== false,
    serviceChargePct: Number(d.serviceChargePct) || 0,
    cgstPct: d.cgstPct == null ? 2.5 : Number(d.cgstPct) || 0,
    sgstPct: d.sgstPct == null ? 2.5 : Number(d.sgstPct) || 0,
  };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const outletId = await getCurrentOutletId();

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as any;
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    if (order.status !== 'open') return Response.json({ error: 'Only an open order can be put on hold' }, { status: 409 });
    if (!canApproveTableOp(me) && !canWorkTable(db, me, order.table_id)) {
      return Response.json({ error: 'You are not allowed to hold this bill' }, { status: 403 });
    }

    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id) as any[];
    if (items.length === 0) return Response.json({ error: 'Order has no items' }, { status: 400 });
    const b = await req.json().catch(() => ({}));
    const reason = String(b?.reason || '').slice(0, 200);

    const date = todayIST();
    const saleTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());

    const bill = computeBill(
      { subtotal: order.subtotal, itemTax: sumItemTax(items), serviceRemoved: !!order.service_charge_reason, discount_pct: order.discount_pct, discount: order.discount },
      loadBillDesign(db),
    );
    const taxTotal = Math.round((bill.cgst + bill.sgst) * 100) / 100;

    let floorStoreId: string | undefined;
    try {
      const zoneRow = order.table_id ? db.prepare('SELECT zone FROM restaurant_tables WHERE id = ?').get(order.table_id) as any : null;
      floorStoreId = resolveFloorStore(db, zoneRow?.zone) || undefined;
    } catch (e) { console.error('[hold floor-resolve]', id, e); floorStoreId = undefined; }

    const hold = db.transaction(() => {
      const freshDeduct = db.prepare('SELECT recipe_deducted_at FROM order_items WHERE id = ?');
      const stampDeduct = db.prepare("UPDATE order_items SET recipe_deducted_at = datetime('now') WHERE id = ?");
      for (const it of items) {
        const mi = it.menu_item_id ? db.prepare('SELECT pos_id FROM menu_items WHERE id = ?').get(it.menu_item_id) as any : null;
        // Re-read the deduction stamp INSIDE the transaction (a KDS bump can land
        // across the req.json() await), and stamp the backstop deduct so a later
        // bump (an 'on_hold' order passes bump's status !== 'void' check) can't
        // deduct these items again — settle-from-hold skips its item loop, so
        // nothing downstream would ever repair a double-deduct here.
        const alreadyDeducted = !!(freshDeduct.get(it.id) as any)?.recipe_deducted_at;
        recordSale(db, {
          item_name: it.name, recipe_id: it.recipe_id, quantity_sold: it.quantity,
          skip_inventory: alreadyDeducted, store_id: floorStoreId,
          bill_type: order.bill_type || 'normal', selling_price: it.unit_price, date, sale_time: saleTime,
          order_id: order.id, category: it.station || null, server: order.server_name || null,
          order_type: order.order_type || 'dine-in', pos_item_id: mi?.pos_id || null, pos_item_name: it.name, outlet_id: outletId,
        });
        if (!alreadyDeducted && it.recipe_id) stampDeduct.run(it.id);
      }
      db.prepare(`
        UPDATE orders SET status = 'on_hold', service_charge = ?, discount = ?, tax_total = ?, total = ?,
          held_at = datetime('now'), notes = TRIM(COALESCE(notes,'') || CASE WHEN ? <> '' THEN ' [HOLD: ' || ? || ']' ELSE '' END),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(bill.serviceCharge, bill.discount, taxTotal, bill.total, reason, reason, id);
    });
    hold();

    return Response.json({ success: true, order_id: id, total: bill.total, status: 'on_hold', lines: items.length });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id]/hold]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
