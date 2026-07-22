import { getDb, recordSale, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, canApproveTableOp } from '@/lib/auth';
import { canWorkTable } from '@/lib/captain-area';
import { todayIST } from '@/lib/format-date';
import { computeBill, sumItemTax, round2 } from '@/lib/bill-calc';
import { resolveFloorStore } from '@/lib/store-engine';

// Payment methods the cashier can settle with. Split payments record one
// order_payments row per method; the sales dashboard's payment-category breakup
// aggregates these (falling back to orders.payment_method for legacy rows).
const VALID_METHODS = ['cash', 'upi', 'card', 'zomato', 'swiggy', 'dineout', 'cheque', 'other'];

/**
 * Read the 'bill_design' setting (JSON) and pull out the numbers computeBill
 * needs (service charge on/off + pct, cgst/sgst pct). Missing/garbled JSON
 * falls back to safe defaults so settling never breaks on a bad setting.
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

/**
 * Settle an open order: write one `sales` row per line item (deducting inventory
 * via recordSale) and close the order — all in one transaction so a failure can't
 * half-write. Body: { payment_method: 'cash' | 'upi' | 'card' }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const outletId = await getCurrentOutletId();

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as any;
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    // 'open' → full settle. 'on_hold' → payment-only (the sales/inventory + totals
    // were already finalised when the bill was put on hold).
    const fromHold = order.status === 'on_hold';
    if (order.status !== 'open' && !fromHold) return Response.json({ error: 'Order is not open' }, { status: 409 });

    // Authorization — settling closes the bill, writes sales rows + deducts stock,
    // so it must be gated (it previously only checked sign-in). Allow a
    // cashier/manager/admin (canApproveTableOp) OR anyone allowed to work this
    // table (canWorkTable: true for unrestricted operators, and for a captain
    // only within their assigned area) — preserving every existing settle flow
    // while stopping an area-restricted captain from closing arbitrary bills.
    if (!canApproveTableOp(me) && !canWorkTable(db, me, order.table_id)) {
      return Response.json({ error: 'You are not allowed to settle this bill' }, { status: 403 });
    }

    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id) as any[];
    if (items.length === 0) return Response.json({ error: 'Order has no items' }, { status: 400 });

    const b = await req.json().catch(() => ({}));

    const date = todayIST();
    const saleTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());

    // Compute the authoritative bill breakdown (service charge, discount, taxes,
    // total) from the current order + the bill_design settings, so the stored
    // totals match exactly what the printed bill renders via the same helper.
    const billDesign = loadBillDesign(db);
    const bill = computeBill(
      {
        subtotal: order.subtotal,
        itemTax: sumItemTax(items),   // per-item GST (food 5% / liquor 0%)
        serviceRemoved: !!order.service_charge_reason,
        discount_pct: order.discount_pct,
        discount: order.discount,
      },
      billDesign,
    );
    const taxTotal = Math.round((bill.cgst + bill.sgst) * 100) / 100;
    // A held bill's total was frozen at hold time — collect exactly that.
    const grand = Math.round(fromHold ? Number(order.total) : bill.total);

    // Resolve payment(s): either a split { payments: [{method, amount}] } that must
    // total the grand amount, or a single { payment_method }. Validated here so a
    // mistyped split can never settle for the wrong money.
    let payments: { method: string; amount: number }[];
    const raw = Array.isArray(b.payments) ? b.payments : null;
    if (raw && raw.length) {
      payments = raw
        .map((p: any) => ({ method: String(p?.method || '').toLowerCase(), amount: round2(Number(p?.amount) || 0) }))
        .filter((p: any) => p.amount > 0);
      if (!payments.length) return Response.json({ error: 'No valid payment amounts' }, { status: 400 });
      for (const p of payments) {
        if (!VALID_METHODS.includes(p.method)) {
          return Response.json({ error: `Invalid payment method "${p.method}". Allowed: ${VALID_METHODS.join(', ')}` }, { status: 400 });
        }
      }
      const sum = round2(payments.reduce((s, p) => s + p.amount, 0));
      if (Math.abs(sum - grand) > 1) {
        return Response.json({ error: `Split payments total ₹${sum} but the bill is ₹${grand}` }, { status: 400 });
      }
    } else {
      const method = String(b.payment_method || '').toLowerCase();
      if (!VALID_METHODS.includes(method)) {
        return Response.json({ error: `payment_method must be one of ${VALID_METHODS.join(', ')}` }, { status: 400 });
      }
      payments = [{ method, amount: grand }];
    }
    const primaryMethod = payments.length === 1 ? payments[0].method : 'split';

    // FAIL-SAFE floor routing (Multi-floor bar Phase 2/3): resolve this order's
    // floor bar store from its table zone ONCE. The settle deduct is only a
    // backstop for items not already deducted at KOT-complete; recordSale gates
    // the actual store posting on tm_floor_autodeduct and ignores store_id when
    // skip_inventory is set. Any failure / unmapped zone → undefined → central.
    let floorStoreId: string | undefined;
    try {
      const zoneRow = order.table_id
        ? db.prepare('SELECT zone FROM restaurant_tables WHERE id = ?').get(order.table_id) as any
        : null;
      floorStoreId = resolveFloorStore(db, zoneRow?.zone) || undefined;
    } catch (e) {
      console.error('[settle floor-resolve]', id, e);
      floorStoreId = undefined;
    }

    const settle = db.transaction(() => {
      // A held bill already wrote its sales/inventory rows — don't double-write.
      const freshDeduct = db.prepare('SELECT recipe_deducted_at FROM order_items WHERE id = ?');
      const stampDeduct = db.prepare("UPDATE order_items SET recipe_deducted_at = datetime('now') WHERE id = ?");
      for (const it of (fromHold ? [] : items)) {
        // pos_id from the menu item (stable link); fall back to none.
        const mi = it.menu_item_id
          ? db.prepare('SELECT pos_id FROM menu_items WHERE id = ?').get(it.menu_item_id) as any
          : null;
        // Re-read the deduction stamp INSIDE the transaction: a KDS bump can
        // complete between the items read above and here (across the req.json()
        // await), and the stale row would otherwise deduct a second time.
        const alreadyDeducted = !!(freshDeduct.get(it.id) as any)?.recipe_deducted_at;
        recordSale(db, {
          item_name: it.name,
          recipe_id: it.recipe_id,
          quantity_sold: it.quantity,
          // Already consumed at KOT-complete? Record the sale (revenue) but don't
          // deduct stock again. Not-yet-completed items (e.g. quick-settled without
          // a KDS bump) still deduct here as the backstop.
          skip_inventory: alreadyDeducted,
          // Route the backstop deduct to the floor bar store (no-op unless
          // tm_floor_autodeduct is on and skip_inventory is false).
          store_id: floorStoreId,
          bill_type: order.bill_type || 'normal',
          selling_price: it.unit_price,
          date,
          sale_time: saleTime,
          order_id: order.id,
          category: it.station || null,
          server: order.server_name || null,
          order_type: order.order_type || 'dine-in',
          pos_item_id: mi?.pos_id || null,
          pos_item_name: it.name,
          outlet_id: outletId,
        });
        // Stamp the backstop deduct so a later KDS bump (the settled order still
        // passes bump's status !== 'void' check) can't deduct these items again.
        // Same recipe gate as recordSale's deduct ('' never deducts). Inside the
        // transaction, so a recordSale throw rolls the stamp back too.
        if (!alreadyDeducted && it.recipe_id) stampDeduct.run(it.id);
      }
      // Store the computed breakdown before marking settled so the settled row
      // is the single source of truth for the charged amounts. A held bill's
      // totals were frozen at hold time → only record the payment + close it.
      // Store `grand` (the whole-rupee amount actually collected, validated and
      // printed) as orders.total — NOT the unrounded bill.total — so the settled
      // row, order_payments and the printed bill all agree, and reports equal what
      // was charged.
      if (fromHold) {
        db.prepare(`UPDATE orders SET status = 'settled', payment_method = ?, total = ?, settled_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
          .run(primaryMethod, grand, id);
      } else {
        db.prepare(`
          UPDATE orders SET status = 'settled', payment_method = ?,
            service_charge = ?, discount = ?, tax_total = ?, total = ?,
            settled_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?
        `).run(primaryMethod, bill.serviceCharge, bill.discount, taxTotal, grand, id);
      }
      // Record each tender line (clear any prior rows first so a retry can't
      // double-insert). Powers the dashboard's payment-category breakup + split.
      db.prepare('DELETE FROM order_payments WHERE order_id = ?').run(id);
      const insP = db.prepare(
        'INSERT INTO order_payments (id, order_id, outlet_id, method, amount, created_by) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const p of payments) insP.run(generateId(), id, outletId, p.method, p.amount, me.email);
    });
    settle();

    return Response.json({ success: true, order_id: id, total: bill.total, payment_method: primaryMethod, payments, lines: items.length });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id]/settle]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
