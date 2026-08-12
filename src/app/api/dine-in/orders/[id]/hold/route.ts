import { getDb, recordSale } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { settleAuthority, recordSettleOverride } from '@/lib/settle-authority';
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
 *
 * GATED BY THE SAME FUNCTION AS SETTLE, AND THAT IS NOT OPTIONAL. Hold performs
 * every irreversible half of a settle except taking the money — it writes the
 * sales rows, deducts the stock and FREEZES the totals, and settle-from-hold
 * then collects exactly the frozen `orders.total` and skips its own item loop.
 * So anyone who can hold a bill can decide what that bill will cost. Both routes
 * call settleAuthority() from src/lib/settle-authority.ts and nothing else; gate
 * settle alone and hold is the bypass.
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
    // Same authority as settle — see the header. Actor from the session cookie,
    // floor re-derived server-side from the ORDER's table, decided before
    // req.json() is read, so no body field or header can influence it. The
    // refusal carries `reason` + the offer flags so the UI can show a check-in
    // or take-over button instead of a bare 403.
    const auth = settleAuthority(db, me, order, outletId);
    if (!auth.allowed) {
      return Response.json({
        error: auth.message,
        reason: auth.reason,
        floor: auth.floor,
        floorName: auth.floorName,
        // Trimmed exactly as settle does — same authority, same payload shape.
        cashier: auth.cashier ? { userId: auth.cashier.userId, userName: auth.cashier.userName } : null,
        offerCheckIn: auth.offerCheckIn,
        offerTakeOver: auth.offerTakeOver,
      }, { status: auth.status });
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
          // DEPARTMENT ROUTING: pass the LINE's station (order_items.station) so the
          // deduct lands on the department that actually cooked it. It must be this
          // column and never kots.station — the KOT writer coerces a blank line
          // station to the literal 'kitchen', and 'Kitchen' is a real department
          // (the main-kitchen roll-up), so resolving off the ticket would silently
          // debit the wrong kitchen for every station-less item.
          // Pass it RAW. Do not default it to 'kitchen' and do not fall back to a
          // parent department: a blank or unmapped station (sushi, terracegrill) is
          // meant to SKIP the department debit and log why, because guessing the
          // wrong kitchen is worse than not deducting. Liquor lines land here too
          // and are carved out downstream on the store rail — not here.
          station: it.station || null,
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

    // THE OVERRIDE LEDGER — same as settle: hold freezes the same totals and
    // writes the same sales rows, so a management hold past a live floor
    // cashier is recorded identically ('cashier.override_hold'). After the
    // commit; a no-op unless the authority result was 'manager_override'.
    recordSettleOverride(db, auth, { actor: me, orderId: id, action: 'hold', outletId });

    return Response.json({
      success: true, order_id: id, total: bill.total, status: 'on_hold', lines: items.length,
      // SURFACE THE OVERRIDE — identical to settle's success payload: when
      // management held past a live floor cashier, the client renders "Held by
      // <manager> — <cashier> holds this floor" from these recorded facts.
      // null on every ordinary hold.
      override: auth.reason === 'manager_override' && auth.override
        ? {
            by: String(me.name || me.email || ''),
            bypassed: auth.override.bypassed.userName || 'the floor cashier',
            floor: auth.floor,
            floorName: auth.floorName,
          }
        : null,
    });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id]/hold]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
